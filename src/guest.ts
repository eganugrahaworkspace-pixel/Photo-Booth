import { isPhotoId } from "../lib/photo.ts";

const FILE_NAME = "dari-photobooth.jpg";
const NOT_FOUND = "Foto tidak ditemukan atau sudah melewati 7 hari.";
const LOAD_FAILED = "Foto belum bisa dimuat. Periksa koneksi lalu tekan Coba lagi.";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} tidak ditemukan`);
  return node as T;
}

const messageEl = el<HTMLParagraphElement>("message");
const photoEl = el<HTMLImageElement>("photo");
const saveBtn = el<HTMLButtonElement>("save");
const howtoEl = el<HTMLDivElement>("howto");
const retryBtn = el<HTMLButtonElement>("retry");
const linkEl = el<HTMLAnchorElement>("download");

// The page is served at /p/<id> (vercel.json rewrites it to p.html), so the id is the last path segment.
function photoIdFromPath(path: string): string {
  const match = /^\/p\/([^/]+)\/?$/.exec(path);
  return match ? match[1] : "";
}

const photoId = photoIdFromPath(location.pathname);
let photoBlob: Blob | null = null;
let objectUrl: string | null = null;

function showMessage(text: string, isError: boolean): void {
  messageEl.textContent = text;
  messageEl.classList.toggle("error", isError);
  messageEl.hidden = false;
}

function showLoading(): void {
  photoEl.hidden = true;
  saveBtn.hidden = true;
  howtoEl.hidden = true;
  retryBtn.hidden = true;
  showMessage("Memuat foto…", false);
}

function showPhoto(blob: Blob): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  photoBlob = blob;
  objectUrl = URL.createObjectURL(blob);
  photoEl.src = objectUrl;
  photoEl.hidden = false;
  messageEl.hidden = true;
  saveBtn.hidden = false;
  howtoEl.hidden = false;
  retryBtn.hidden = true;
}

async function load(): Promise<void> {
  // An invalid id is answered locally, so it never reaches the API.
  if (!isPhotoId(photoId)) {
    showMessage(NOT_FOUND, true);
    return;
  }
  showLoading();
  try {
    const res = await fetch(`/api/photo?id=${photoId}`, { cache: "no-store" });
    if (res.status === 404) {
      showMessage(NOT_FOUND, true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showPhoto(new Blob([await res.blob()], { type: "image/jpeg" }));
  } catch {
    showMessage(LOAD_FAILED, true);
    retryBtn.hidden = false;
  }
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

function download(): void {
  if (!objectUrl) return;
  linkEl.href = objectUrl;
  linkEl.click();
}

// True while a share sheet is open. A second share() call would be rejected with InvalidStateError,
// which must not be mistaken for a failed share and sent to the download fallback.
let sharing = false;

async function save(): Promise<void> {
  if (!photoBlob || sharing) return;
  const file = new File([photoBlob], FILE_NAME, { type: "image/jpeg" });
  // Called straight from the click, before any await, so the browser still counts it as a user gesture.
  if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    sharing = true;
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      // Dismissing the share sheet is not an error. Any other failure falls back to a download.
      if (isAbortError(err)) return;
    } finally {
      sharing = false;
    }
  }
  download();
}

saveBtn.addEventListener("click", () => void save());
retryBtn.addEventListener("click", () => void load());
void load();
