import QRCode from "qrcode";
import { newPhotoId } from "../lib/photo.ts";
import { next, type Event as FlowEvent, type State } from "./flow.ts";
import { currentDeviceId, listCameras, startCamera } from "./camera.ts";
import { renderPhoto } from "./render.ts";
import { UploadError, uploadPhoto } from "./upload.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const video = $<HTMLVideoElement>("video");
const twibbonImg = $<HTMLImageElement>("twibbon");
const twibbonSelect = $<HTMLSelectElement>("twibbon-select");
const cameraLabel = $<HTMLLabelElement>("camera-label");
const cameraSelect = $<HTMLSelectElement>("camera-select");
const countdownEl = $<HTMLDivElement>("countdown");
const statusEl = $<HTMLParagraphElement>("status");
const shootBtn = $<HTMLButtonElement>("shoot");
const retryBtn = $<HTMLButtonElement>("retry");
const nextBtn = $<HTMLButtonElement>("next");
const keyForm = $<HTMLFormElement>("key-form");
const keyInput = $<HTMLInputElement>("key-input");
const qrBox = $<HTMLDivElement>("qr-box");
const qrCanvas = $<HTMLCanvasElement>("qr");

const CAMERA_STORAGE = "booth-camera";
const KEY_STORAGE = "booth-key";

const MSG = {
  ready: "Siap. Tekan Ambil Foto.",
  cameraDenied: "Kamera belum diizinkan. Buka Pengaturan Safari, izinkan Kamera, lalu muat ulang.",
  cameraFail: "Kamera tidak bisa dibuka. Muat ulang halaman.",
  twibbonFail: "Twibbon gagal dimuat.",
  captureFail: "Kamera belum siap. Tunggu sebentar lalu coba lagi.",
  uploading: "Mengunggah foto…",
  uploadFail: "Gagal mengunggah foto. Periksa koneksi lalu tekan Coba lagi.",
  done: "Foto tersimpan. Pindai QR untuk membuka foto.",
  keyNeeded: "Masukkan kunci booth untuk mengunggah.",
  keyWrong: "Kunci booth salah. Masukkan kunci yang benar, lalu tekan Coba lagi.",
  keySaved: "Kunci disimpan.",
  keySavedRetry: "Kunci disimpan. Tekan Coba lagi.",
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
let twibbonReady = false;
let photoId: string | null = null;
let photoJpeg: Blob | null = null;
let keyCache: string | null = storageGet(KEY_STORAGE);

function send(e: FlowEvent): void {
  state = next(state, e);
  render();
}

function setStatus(msg: string, error = false): void {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
}

function render(): void {
  const idle = state === "idle";
  shootBtn.disabled = !(idle && cameraReady && twibbonReady);
  twibbonSelect.disabled = !idle;
  cameraSelect.disabled = !idle;
  retryBtn.hidden = state !== "failed";
  nextBtn.hidden = state !== "done" && state !== "failed";
  qrBox.hidden = state !== "done";
}

function showKeyForm(msg: string): void {
  keyForm.hidden = false;
  setStatus(msg, true);
  keyInput.focus();
}

function clearKey(): void {
  keyCache = null;
  storageDel(KEY_STORAGE);
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? MSG.cameraDenied : MSG.cameraFail;
}

async function initCamera(): Promise<void> {
  try {
    await startCamera(video);
  } catch (err) {
    cameraReady = false;
    setStatus(cameraErrorMessage(err), true);
    render();
    return;
  }
  cameraReady = true;

  // Labels and ids are only available after permission, so the saved camera is checked now.
  let cameras = await listCameras();
  const saved = storageGet(CAMERA_STORAGE);
  if (saved && saved !== currentDeviceId(video)) {
    if (cameras.some((c) => c.deviceId === saved)) {
      await startCamera(video, saved).catch(() => {
        // Keep the default camera running.
      });
    } else {
      storageDel(CAMERA_STORAGE);
    }
  }

  cameras = await listCameras();
  cameraSelect.replaceChildren(
    ...cameras.map((c, i) => new Option(c.label || `Kamera ${i + 1}`, c.deviceId)),
  );
  cameraSelect.value = currentDeviceId(video) ?? "";
  cameraLabel.hidden = cameras.length < 2;

  if (keyCache) setStatus(MSG.ready);
  else setStatus(MSG.keyNeeded, true);
  render();
}

async function switchCamera(deviceId: string): Promise<void> {
  cameraReady = false;
  render();
  try {
    await startCamera(video, deviceId);
    storageSet(CAMERA_STORAGE, deviceId);
    setStatus(MSG.ready);
  } catch {
    // The previous stream is still running, so revert the selection.
    cameraSelect.value = currentDeviceId(video) ?? "";
    setStatus("Kamera itu tidak bisa dibuka. Pilih kamera lain.", true);
  }
  cameraReady = true;
  render();
}

async function loadTwibbon(name: string): Promise<void> {
  twibbonReady = false;
  render();
  twibbonImg.src = `/twibbon/${name}.png`;
  try {
    await twibbonImg.decode();
  } catch {
    if (twibbonSelect.value === name) setStatus(MSG.twibbonFail, true);
    return;
  }
  if (twibbonSelect.value !== name) return; // A newer choice has replaced this one.
  twibbonReady = true;
  render();
}

async function shoot(): Promise<void> {
  if (state !== "idle" || !cameraReady || !twibbonReady) return;
  setStatus("");
  send("shoot");

  for (let n = 3; n >= 1; n--) {
    countdownEl.textContent = String(n);
    countdownEl.hidden = false;
    await sleep(1000);
  }
  countdownEl.hidden = true;

  let jpeg: Blob;
  try {
    jpeg = await renderPhoto(video, twibbonImg);
  } catch {
    setStatus(MSG.captureFail, true);
    send("error");
    return;
  }
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
      showKeyForm(MSG.keyWrong);
    } else {
      setStatus(MSG.uploadFail, true);
    }
    send("error");
    return;
  }

  send("uploaded");
  setStatus(MSG.done);
  try {
    await QRCode.toCanvas(qrCanvas, `${location.origin}/p/${photoId}`, { width: 240, margin: 1 });
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
  send("next");
  photoId = null;
  photoJpeg = null;
  qrCanvas.getContext("2d")?.clearRect(0, 0, qrCanvas.width, qrCanvas.height);
  setStatus(MSG.ready);
}

shootBtn.addEventListener("click", () => void shoot());
retryBtn.addEventListener("click", () => void retry());
nextBtn.addEventListener("click", reset);
twibbonSelect.addEventListener("change", () => void loadTwibbon(twibbonSelect.value));
cameraSelect.addEventListener("change", () => void switchCamera(cameraSelect.value));
keyForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = keyInput.value.trim();
  if (!value) return;
  keyCache = value;
  storageSet(KEY_STORAGE, value);
  keyInput.value = "";
  keyForm.hidden = true;
  setStatus(state === "failed" ? MSG.keySavedRetry : MSG.keySaved);
  render();
});

setStatus("Menyiapkan kamera…");
render();
if (!keyCache) showKeyForm(MSG.keyNeeded);
void loadTwibbon(twibbonSelect.value);
void initCamera();
