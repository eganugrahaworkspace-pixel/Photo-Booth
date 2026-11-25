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
import { renderCollage, renderPhoto, captureFrame } from "./render.ts";
import { collageCells, countdownFor, parseMode, type Cell, type Mode } from "./collage.ts";
import { UploadError, uploadPhoto } from "./upload.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const previewEl = $<HTMLDivElement>("preview");
const twibbonImg = $<HTMLImageElement>("twibbon");
const twibbonSelect = $<HTMLSelectElement>("twibbon-select");
const twibbonRetryBtn = $<HTMLButtonElement>("twibbon-retry");
const modeGroup = $<HTMLFieldSetElement>("mode");
const modeInputs = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
const cameraLabel = $<HTMLLabelElement>("camera-label");
const cameraSelect = $<HTMLSelectElement>("camera-select");
const countdownEl = $<HTMLDivElement>("countdown");
const guideEl = $<HTMLDivElement>("crop-guide");
const countdownNumEl = $<HTMLSpanElement>("countdown-num");
const countdownLabelEl = $<HTMLSpanElement>("countdown-label");
const statusEl = $<HTMLParagraphElement>("status");
const shootBtn = $<HTMLButtonElement>("shoot");
const retryBtn = $<HTMLButtonElement>("retry");
const nextBtn = $<HTMLButtonElement>("next");
const qrBox = $<HTMLDivElement>("qr-box");
const qrCanvas = $<HTMLCanvasElement>("qr");
const resultImg = $<HTMLImageElement>("result");
const doneHelp = $<HTMLDivElement>("done-help");

const CAMERA_STORAGE = "booth-camera";
// Earlier builds stored an operator key here; it is no longer used and is removed on load.
const LEGACY_KEY_STORAGE = "booth-key";
const DISCARD_WINDOW_MS = 4000;
// A finished photo is cleared after this so the next visitor never sees the previous guest's photo.
const DONE_AUTO_RESET_MS = 60_000;
// The chosen photo count is kept across visits; it is not reset with the rest of the flow.
const MODE_STORAGE = "booth-mode";
const COLLAGE_FLASH_MS = 150;
const SHOT_STEP_MS = 700;

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
let doneTimer: ReturnType<typeof setTimeout> | null = null;
let photoId: string | null = null;
let photoJpeg: Blob | null = null;
// Object URL of the taken photo shown on the result screen; revoked in reset().
let resultUrl: string | null = null;

function cancelDoneTimer(): void {
  if (doneTimer !== null) clearTimeout(doneTimer);
  doneTimer = null;
}

// Only the done state auto-resets. failed never does: the operator must be able to retry.
function syncDoneTimer(): void {
  cancelDoneTimer();
  if (state !== "done") return;
  doneTimer = setTimeout(() => {
    doneTimer = null;
    if (state === "done") reset();
  }, DONE_AUTO_RESET_MS);
}

function send(e: FlowEvent): void {
  const prev = state;
  state = next(state, e);
  if (state !== prev) syncDoneTimer();
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
  modeInputs.forEach((input) => (input.disabled = !idle));
  updateGuide();
  twibbonSelect.disabled = !idle;
  twibbonRetryBtn.hidden = !twibbonFailed;
  twibbonRetryBtn.disabled = !idle;
  cameraSelect.disabled = !idle;
  retryBtn.hidden = state !== "failed";
  nextBtn.hidden = state !== "done" && state !== "failed";
  qrBox.hidden = state !== "done";
  doneHelp.hidden = state !== "done";
  resultImg.hidden = state === "idle" || state === "countdown";
  document.body.dataset.state = state;
  const line = statusLine();
  statusEl.textContent = line.text;
  statusEl.classList.toggle("error", line.error);
  paintNext();
  setCameraHold(!idle);
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
  setReadyStatus();
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

// Shot canvases can be several MB each at 4:3 cell sizes; release them as soon as they are composed or dropped.
function releaseFrames(frames: HTMLCanvasElement[]): void {
  for (const f of frames) {
    f.width = 0;
    f.height = 0;
  }
  frames.length = 0;
}

// Crop guide: the first cell's aspect, centred and as large as fits the 9:16 preview.
function layoutGuide(cell: Cell): void {
  const W = previewEl.clientWidth;
  const H = previewEl.clientHeight;
  if (!W || !H) return;
  const a = cell.w / cell.h;
  const w = W / H > a ? H * a : W;
  const h = W / H > a ? H : W / a;
  guideEl.style.width = `${w}px`;
  guideEl.style.height = `${h}px`;
}

function updateGuide(): void {
  const mode = selectedMode();
  const show = mode > 1 && (state === "idle" || state === "countdown");
  guideEl.hidden = !show;
  if (show) layoutGuide(collageCells(mode)[0]);
}

function selectedMode(): Mode {
  return parseMode(document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value);
}

function setCountdownLabel(text: string): void {
  countdownLabelEl.textContent = text;
  countdownLabelEl.hidden = text === "";
}

// Brief white flash over the preview after a collage shot. Reduced motion gets no flash and no pause.
async function flashPreview(): Promise<void> {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  previewEl.classList.add("flash");
  await sleep(COLLAGE_FLASH_MS);
  previewEl.classList.remove("flash");
}

// Takes every shot for the chosen mode. Returns false on abort or failure, after the state is already set.
async function takeShots(run: number, mode: Mode, cells: Cell[], frames: HTMLCanvasElement[]): Promise<boolean> {
  for (let shot = 0; shot < mode; shot++) {
    for (const n of countdownFor(shot)) {
      if (run !== countdownRun) return false;
      countdownNumEl.textContent = String(n);
      setCountdownLabel(mode > 1 ? `Foto ${shot + 1} dari ${mode}` : "");
      countdownEl.hidden = false;
      await sleep(SHOT_STEP_MS);
    }
    if (run !== countdownRun) return false;
    countdownEl.hidden = true;

    // The camera can drop during the countdown; a stale frame must never become a photo.
    if (!isCameraUsable(video)) {
      send("error");
      refuseCapture();
      return false;
    }

    if (mode > 1) {
      try {
        frames.push(captureFrame(video, cells[shot]));
      } catch {
        if (run !== countdownRun) return false;
        setStatus(MSG.captureFail, true);
        send("error");
        return false;
      }
      await flashPreview();
      if (run !== countdownRun) return false;
    }
  }
  return true;
}

async function shoot(): Promise<void> {
  if (state !== "idle" || !PUBLIC_ORIGIN || !cameraReady || !twibbonReady) return;
  if (!isCameraUsable(video)) {
    refuseCapture();
    return;
  }
  const mode = selectedMode();
  const cells = collageCells(mode);
  setStatus("");
  send("shoot");

  // Any abort or failure drops every frame taken so far: nothing partial is composed.
  const run = ++countdownRun;
  const frames: HTMLCanvasElement[] = [];
  if (!(await takeShots(run, mode, cells, frames))) {
    releaseFrames(frames);
    return;
  }

  let jpeg: Blob;
  try {
    jpeg = mode === 1 ? await renderPhoto(video, twibbonImg) : await renderCollage(frames, cells, twibbonImg);
  } catch {
    releaseFrames(frames);
    // An aborted shot already reset the state and status; its render failure is not the guest's to see.
    if (run !== countdownRun) return;
    setStatus(MSG.captureFail, true);
    send("error");
    return;
  }
  releaseFrames(frames);
  // Hiding the page during render aborts the shot: no photo id, no upload.
  if (run !== countdownRun) return;
  // A new shot gets a new id. Retries reuse the same id and Blob.
  photoId = newPhotoId();
  photoJpeg = jpeg;
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = URL.createObjectURL(jpeg);
  resultImg.src = resultUrl;
  send("captured");
  await upload();
}

async function upload(): Promise<void> {
  if (!photoId || !photoJpeg) return;

  setStatus(MSG.uploading);
  try {
    await uploadPhoto(photoId, photoJpeg);
  } catch (err) {
    if (err instanceof UploadError && err.status >= 500) {
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
    await QRCode.toCanvas(qrCanvas, `${PUBLIC_ORIGIN}/p/${photoId}`, { width: 200, margin: 1 });
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
  cancelDoneTimer();
  send("next");
  photoId = null;
  photoJpeg = null;
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  resultImg.removeAttribute("src");
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
modeGroup.addEventListener("change", () => {
  storageSet(MODE_STORAGE, String(selectedMode()));
  render();
});
new ResizeObserver(() => updateGuide()).observe(previewEl);
{
  const savedMode = parseMode(storageGet(MODE_STORAGE));
  const savedInput = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${savedMode}"]`);
  if (savedInput) savedInput.checked = true;
}
storageDel(LEGACY_KEY_STORAGE);
setStatus(MSG.preparing);
void loadTwibbon(twibbonSelect.value);
void initCamera();
