import { coverCrop } from "./compose.ts";

export const PHOTO_W = 1080;
export const PHOTO_H = 1920;

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
      0.9,
    );
  });
}
