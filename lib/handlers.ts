import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_BYTES, isPhotoId, isJpeg, isExpired } from "./photo.js";

// Storage port. The real adapter (lib/blob-store.ts) wraps @vercel/blob;
// tests use an in-memory fake. Keeping this file free of @vercel/blob lets it run under node:test.
export interface Store {
  put(path: string, b: Uint8Array): Promise<void>;
  head(path: string): Promise<{ uploadedAt: Date; url: string } | null>;
  list(): Promise<{ path: string; uploadedAt: Date }[]>;
  del(paths: string[]): Promise<void>;
}

function photoPath(id: string): string {
  return `photos/${id}.jpg`;
}

// Hash both sides to a fixed length so timingSafeEqual never sees different lengths.
function secretMatches(given: string, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function handlePut(
  req: { id: string; key: string | null; body: Uint8Array },
  store: Store,
  boothKey: string,
): Promise<number> {
  if (req.key === null || !secretMatches(req.key, boothKey)) return 401;
  if (!isPhotoId(req.id)) return 400;
  if (req.body.byteLength > MAX_BYTES) return 413;
  if (!isJpeg(req.body)) return 415;
  await store.put(photoPath(req.id), req.body);
  return 201;
}

export async function resolvePhoto(id: string, store: Store, now: Date): Promise<string | null> {
  if (!isPhotoId(id)) return null;
  const found = await store.head(photoPath(id));
  if (!found || isExpired(found.uploadedAt, now)) return null;
  return found.url;
}

export async function cleanup(store: Store, now: Date): Promise<number> {
  const expired = (await store.list())
    .filter((f) => isExpired(f.uploadedAt, now))
    .map((f) => f.path);
  if (expired.length === 0) return 0;
  await store.del(expired);
  return expired.length;
}

export function isCronAuthorized(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !authorization) return false;
  return secretMatches(authorization, `Bearer ${secret}`);
}
