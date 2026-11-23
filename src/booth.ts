/// <reference types="vite/client" />
import QRCode from "qrcode";
import { newPhotoId } from "../lib/photo.ts";
import { next, type Event as FlowEvent, type State } from "./flow.ts";
import {
  currentDeviceId,
  isCameraUsable,
  listCameras,
  onCameraState,
  setCameraHold,
  startCamera,
} from "./camera.ts";
import { renderPhoto } from "./render.ts";
import { UploadError, uploadPhoto } from "./upload.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const twibbonImg = $<HTMLImageElement>("twibbon");
const twibbonSelect = $<HTMLSelectElement>("twibbon-select");
const twibbonRetryBtn = $<HTMLButtonElement>("twibbon-retry");
const cameraLabel = $<HTMLLabelElement>("camera-label");
const cameraSelect = $<HTMLSelectElement>("camera-select");
const countdownEl = $<HTMLDivElement>("countdown");
const statusEl = $<HTMLParagraphElement>("status");
const shootBtn = $<HTMLButtonElement>("shoot");
const retryBtn = $<HTMLButtonElement>("retry");
const nextBtn = $<HTMLButtonElement>("next");
const keyForm = $<HTMLFormElement>("key-form");
const keyInput = $<HTMLInputElement>("key-input");
const keyError = $<HTMLParagraphElement>("key-error");
const qrBox = $<HTMLDivElement>("qr-box");
const qrCanvas = $<HTMLCanvasElement>("qr");

const CAMERA_STORAGE = "booth-camera";
const KEY_STORAGE = "booth-key";
const DISCARD_WINDOW_MS = 4000;

// The QR must point at the public production domain, never at whatever origin the operator opened
// (preview URLs sit behind a login wall). Dev falls back to the local origin.
function resolvePublicOrigin(): string | null {
  const raw = (import.meta.env.VITE_PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (raw) {
    try {
      if (new URL(raw).protocol === "https:") return raw;
    } catch {
      // Not a URL; treated as missing below.
    }
  }
  return import.meta.env.DEV ? location.origin : null;
}
const PUBLIC_ORIGIN = resolvePublicOrigin();

const MSG = {
  ready: "Siap. Tekan Ambil Foto.",
  originMissing: "Alamat publik belum diatur. Hubungi admin.",
  cameraDenied: "Kamera belum diizinkan. Buka Pengaturan Safari, izinkan Kamera, lalu muat ulang.",
  cameraFail: "Kamera tidak bisa dibuka. Muat ulang halaman.",
  cameraLost: "Kamera terputus. Sambungkan lagi, lalu muat ulang halaman.",
  countdownAborted: "Pengambilan foto dibatalkan karena halaman disembunyikan. Tekan Ambil Foto lagi.",
  twibbonFail: "Twibbon gagal dimuat.",
  twibbonRetry: "Muat ulang twibbon",
  setupFail: "Daftar kamera gagal dimuat. Muat ulang halaman.",
  captureFail: "Kamera belum siap. Tunggu sebentar lalu coba lagi.",
  uploading: "Mengunggah foto…",
  uploadFail: "Gagal mengunggah foto. Periksa koneksi lalu tekan Coba lagi.",
  serverFail: "Server bermasalah. Coba lagi, atau hubungi admin.",
  done: "Foto tersimpan. Pindai QR untuk membuka foto.",
  keyNeeded: "Masukkan kunci booth untuk mengunggah.",
  keyWrong: "Kunci booth salah. Masukkan kunci yang benar, lalu tekan Coba lagi.",
  keyWrongPanel: "Kunci booth salah. Masukkan lagi.",
  keySaved: "Kunci disimpan.",
  keySavedRetry: "Kunci disimpan. Tekan Coba lagi.",
  preparing: "Menyiapkan kamera…",
  discardConfirm: "Yakin hapus foto ini?",
  next: "Foto berikutnya",
};

// localStorage can throw in private windows or with blocked site data.
function storageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function storageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    // Not persisted; the in-memory copy still works for this page load.
  }
}
function storageDel(k: string): void {
  try {
    localStorage.removeItem(k);
  } catch {
    // Nothing stored to remove.
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let state: State = "idle";
let cameraReady = false;
// Set only when initCamera has applied the saved camera and filled the dropdown; until then the booth stays off.
let setupDone = false;
let twibbonReady = false;
let twibbonFailed = false;
// Camera problems (denied, lost) stay on screen until resolved; transient messages do not replace them.
let cameraError: string | null = null;
let msg = "";
let msgError = false;
// "Siap" is derived at render time from camera and twibbon readiness, never set as a fixed string.
let showReady = false;
// Bumped to abort an in-flight countdown; a stale countdown loop sees the mismatch and stops.
let countdownRun = 0;
let discardArmed = false;
let discardTimer: ReturnType<typeof setTimeout> | null = null;
let photoId: string | null = null;
let photoJpeg: Blob | null = null;
let keyCache: string | null = storageGet(KEY_STORAGE);

function send(e: FlowEvent): void {
  state = next(state, e);
  render();
}

function setStatus(text: string, error = false): void {
  showReady = false;
  msg = text;
  msgError = error;
  render();
}

function setReadyStatus(): void {
  showReady = true;
  msg = "";
  msgError = false;
  render();
}

// Upload outcomes outrank camera trouble in the upload phases: the guest must learn whether the photo was saved.
function statusLine(): { text: string; error: boolean } {
  if (!PUBLIC_ORIGIN) return { text: MSG.originMissing, error: true };
  if (state === "uploading" || state === "failed" || state === "done") return { text: msg, error: msgError };
  if (cameraError) return { text: cameraError, error: true };
  if (twibbonFailed) return { text: MSG.twibbonFail, error: true };
  if (showReady) return { text: cameraReady && twibbonReady ? MSG.ready : MSG.preparing, error: false };
  return { text: msg, error: msgError };
}

function paintNext(): void {
  nextBtn.textContent = discardArmed ? MSG.discardConfirm : MSG.next;
}

function disarmDiscard(): void {
  discardArmed = false;
  if (discardTimer !== null) clearTimeout(discardTimer);
  discardTimer = null;
  paintNext();
}

function render(): void {
  const idle = state === "idle";
  if (state !== "failed") disarmDiscard();
  shootBtn.disabled = !(idle && PUBLIC_ORIGIN && cameraReady && twibbonReady);
  twibbonSelect.disabled = !idle;
  twibbonRetryBtn.hidden = !twibbonFailed;
  twibbonRetryBtn.disabled = !idle;
  cameraSelect.disabled = !idle;
  retryBtn.hidden = state !== "failed";
  nextBtn.hidden = state !== "done" && state !== "failed";
  qrBox.hidden = state !== "done";
  document.body.dataset.state = state;
  const line = statusLine();
  statusEl.textContent = line.text;
  statusEl.classList.toggle("error", line.error);
  paintNext();
  setCameraHold(!idle);
}

// The key panel is fixed in the viewport, so focusing it while visible cannot scroll the page.
function showKeyForm(text: string): void {
  keyForm.hidden = false;
  setStatus(text, true);
  keyInput.focus({ preventScroll: true });
}

function clearKey(): void {
  keyCache = null;
  storageDel(KEY_STORAGE);
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? MSG.cameraDenied : MSG.cameraFail;
}

// Keeps readiness and the lost-camera message in step with the track.
function applyCameraUsable(usable: boolean): void {
  // A restart can make the stream usable before setup has run, so setup must finish before shooting is enabled.
  cameraReady = usable && setupDone;
  if (usable) {
    if (cameraError === MSG.cameraLost) cameraError = null;
  } else if (!cameraError) {
    // A setup error (camera never opened) stays on screen; a restart must not replace it with "terputus".
    cameraError = MSG.cameraLost;
  }
  render();
}

function refuseCapture(): void {
  applyCameraUsable(false);
}

async function initCamera(): Promise<void> {
  try {
    await startCamera(video);
  } catch (err) {
    cameraReady = false;
    cameraError = cameraErrorMessage(err);
    render();
    return;
  }

  let cameras: MediaDeviceInfo[];
  try {
    // Labels and ids are only available after permission, so the saved camera is checked now.
    cameras = await listCameras();
    const saved = storageGet(CAMERA_STORAGE);
    if (saved && saved !== currentDeviceId(video)) {
      if (cameras.some((c) => c.deviceId === saved)) {
        // Shooting stays off while the swap is pending; the default stream is still on the video.
        cameraReady = false;
        render();
        await startCamera(video, saved).catch(() => {
          // Keep the default camera running.
        });
        // A superseded swap reports nothing itself, so the gate decides from the current stream.
        applyCameraUsable(isCameraUsable(video));
      } else {
        storageDel(CAMERA_STORAGE);
      }
    }

    cameras = await listCameras();
  } catch {
    // Setup never finished, so setupDone stays false and the booth stays off until a reload.
    cameraReady = false;
    setStatus(MSG.setupFail, true);
    return;
  }
  cameraSelect.replaceChildren(
    ...cameras.map((c, i) => new Option(c.label || `Kamera ${i + 1}`, c.deviceId)),
  );
  cameraSelect.value = currentDeviceId(video) ?? "";
  cameraLabel.hidden = cameras.length < 2;

  setupDone = true;
  applyCameraUsable(isCameraUsable(video));

  if (keyCache) setReadyStatus();
  else showKeyForm(MSG.keyNeeded);
}

async function switchCamera(deviceId: string): Promise<void> {
  cameraReady = false;
  render();
  try {
    // A superseded switch leaves the saved id, the status and the readiness to the newer start.
    if (!(await startCamera(video, deviceId))) return;
    storageSet(CAMERA_STORAGE, deviceId);
    setReadyStatus();
  } catch {
    // The previous stream is still running, so revert the selection.
    cameraSelect.value = currentDeviceId(video) ?? "";
    setStatus("Kamera itu tidak bisa dibuka. Pilih kamera lain.", true);
  }
  applyCameraUsable(isCameraUsable(video));
}

async function loadTwibbon(name: string): Promise<void> {
  twibbonReady = false;
  twibbonFailed = false;
  render();
  twibbonImg.src = `/twibbon/${name}.png`;
  try {
    await twibbonImg.decode();
  } catch {
    if (twibbonSelect.value === name) {
      twibbonFailed = true;
      render();
    }
    return;
  }
  if (twibbonSelect.value !== name) return; // A newer choice has replaced this one.
  twibbonReady = true;
  render();
}

// Hiding the page stops the camera, so a countdown that outlives the visit would capture a frozen frame.
function abortCountdown(): void {
  countdownRun++;
  countdownEl.hidden = true;
  send("error");
  setStatus(MSG.countdownAborted, true);
}

async function shoot(): Promise<void> {
  if (state !== "idle" || !PUBLIC_ORIGIN || !cameraReady || !twibbonReady) return;
  if (!isCameraUsable(video)) {
    refuseCapture();
    return;
  }
  setStatus("");
  send("shoot");

  const run = ++countdownRun;
  for (let n = 3; n >= 1; n--) {
    if (run !== countdownRun) return;
    countdownEl.textContent = String(n);
    countdownEl.hidden = false;
    await sleep(1000);
  }
  if (run !== countdownRun) return;
  countdownEl.hidden = true;

  // The camera can drop during the countdown; a stale frame must never become a photo.
  if (!isCameraUsable(video)) {
    send("error");
    refuseCapture();
    return;
  }

  let jpeg: Blob;
  try {
    jpeg = await renderPhoto(video, twibbonImg);
  } catch {
    // An aborted shot already reset the state and status; its render failure is not the guest's to see.
    if (run !== countdownRun) return;
    setStatus(MSG.captureFail, true);
    send("error");
    return;
  }
  // Hiding the page during render aborts the shot: no photo id, no upload.
  if (run !== countdownRun) return;
  // A new shot gets a new id. Retries reuse the same id and Blob.
  photoId = newPhotoId();
  photoJpeg = jpeg;
  send("captured");
  await upload();
}

async function upload(): Promise<void> {
  if (!photoId || !photoJpeg) return;
  const key = keyCache;
  if (!key) {
    showKeyForm(MSG.keyNeeded);
    send("error");
    return;
  }

  setStatus(MSG.uploading);
  try {
    await uploadPhoto(photoId, photoJpeg, key);
  } catch (err) {
    if (err instanceof UploadError && err.status === 401) {
      clearKey();
      // The status line sits under the fixed key panel on small screens, so the reason is repeated inside it.
      keyError.textContent = MSG.keyWrongPanel;
      keyError.hidden = false;
      showKeyForm(MSG.keyWrong);
    } else if (err instanceof UploadError && err.status >= 500) {
      setStatus(MSG.serverFail, true);
    } else {
      setStatus(MSG.uploadFail, true);
    }
    send("error");
    return;
  }

  send("uploaded");
  setStatus(MSG.done);
  try {
    if (!PUBLIC_ORIGIN) throw new Error("public origin missing");
    await QRCode.toCanvas(qrCanvas, `${PUBLIC_ORIGIN}/p/${photoId}`, { width: 240, margin: 1 });
  } catch {
    setStatus("Foto tersimpan, tetapi QR gagal dibuat.", true);
  }
}

async function retry(): Promise<void> {
  if (state !== "failed") return;
  send("retry");
  await upload();
}

function reset(): void {
  if (state !== "done" && state !== "failed") return;
  // Discarding an unuploaded photo takes two taps; a finished photo is already saved, so one tap is enough.
  if (state === "failed" && !discardArmed) {
    discardArmed = true;
    discardTimer = setTimeout(disarmDiscard, DISCARD_WINDOW_MS);
    paintNext();
    return;
  }
  disarmDiscard();
  send("next");
  photoId = null;
  photoJpeg = null;
  qrCanvas.getContext("2d")?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
  setReadyStatus();
}

onCameraState(applyCameraUsable);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state === "countdown") abortCountdown();
});

shootBtn.addEventListener("click", () => void shoot());
retryBtn.addEventListener("click", () => void retry());
nextBtn.addEventListener("click", reset);
twibbonRetryBtn.addEventListener("click", () => void loadTwibbon(twibbonSelect.value));
twibbonSelect.addEventListener("change", () => void loadTwibbon(twibbonSelect.value));
cameraSelect.addEventListener("change", () => void switchCamera(cameraSelect.value));
keyForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = keyInput.value.trim();
  if (!value) return;
  keyCache = value;
  storageSet(KEY_STORAGE, value);
  keyInput.value = "";
  keyError.hidden = true;
  keyError.textContent = "";
  keyForm.hidden = true;
  setStatus(state === "failed" ? MSG.keySavedRetry : MSG.keySaved);
});

setStatus(MSG.preparing);
void loadTwibbon(twibbonSelect.value);
void initCamera();
