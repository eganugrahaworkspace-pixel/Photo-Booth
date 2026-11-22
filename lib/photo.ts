export const MAX_BYTES = 4_000_000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const PHOTO_ID_RE = /^[A-Za-z0-9_-]{22}$/;

// 128-bit random id, base64url without padding (22 chars).
// Uses Web Crypto so it runs in both browsers and Node.
export function newPhotoId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isPhotoId(s: string): boolean {
  return PHOTO_ID_RE.test(s);
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function isExpired(uploadedAt: Date, now: Date): boolean {
  return now.getTime() - uploadedAt.getTime() > RETENTION_MS;
}
