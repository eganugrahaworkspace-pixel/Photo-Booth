import { coverCrop } from "./compose.ts";
import { cellSourceRect, type Cell } from "./collage.ts";

export const PHOTO_W = 1080;
export const PHOTO_H = 1920;
const COLLAGE_BACKGROUND = "#0E3B37";

// Compose the final 1080x1920 JPEG. The camera frame is mirrored to match
// the preview; the twibbon is drawn last, unmirrored.
export async function renderPhoto(video: HTMLVideoElement, twibbon: HTMLImageElement): Promise<Blob> {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (srcW === 0 || srcH === 0) throw new Error("Kamera belum siap");

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_W;
  canvas.height = PHOTO_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas tidak tersedia");

  const { sx, sy, sw, sh } = coverCrop(srcW, srcH, PHOTO_W, PHOTO_H);
  ctx.save();
  ctx.translate(PHOTO_W, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, PHOTO_W, PHOTO_H);
  ctx.restore();

  ctx.drawImage(twibbon, 0, 0, PHOTO_W, PHOTO_H);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gagal membuat JPEG"))),
      "image/jpeg",
      0.85,
    );
  });
}

// One collage cell: the mirrored frame cut from the same 9:16 region the guest sees in the preview,
// then cover-cropped to the cell's aspect ratio.
export function captureFrame(video: HTMLVideoElement, cell: Cell): HTMLCanvasElement {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (srcW === 0 || srcH === 0) throw new Error("Kamera belum siap");

  const canvas = document.createElement("canvas");
  canvas.width = cell.w;
  canvas.height = cell.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas tidak tersedia");

  const { sx, sy, sw, sh } = cellSourceRect(srcW, srcH, cell, PHOTO_W, PHOTO_H);
  ctx.save();
  ctx.translate(cell.w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cell.w, cell.h);
  ctx.restore();
  return canvas;
}

// Compose the multi-photo frame: frames go into their cells, the twibbon covers the whole 1080x1920.
export async function renderCollage(
  frames: HTMLCanvasElement[],
  cells: Cell[],
  twibbon: HTMLImageElement,
): Promise<Blob> {
  if (frames.length !== cells.length) throw new Error("Jumlah foto tidak sesuai");

  const canvas = document.createElement("canvas");
  canvas.width = PHOTO_W;
  canvas.height = PHOTO_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas tidak tersedia");

  ctx.fillStyle = COLLAGE_BACKGROUND;
  ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);
  cells.forEach((cell, i) => ctx.drawImage(frames[i], cell.x, cell.y, cell.w, cell.h));
  ctx.drawImage(twibbon, 0, 0, PHOTO_W, PHOTO_H);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Gagal membuat JPEG"))),
      "image/jpeg",
      0.85,
    );
  });
}
