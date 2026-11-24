import { createHash, timingSafeEqual } from "node:crypto";
import { MAX_BYTES, isPhotoId, isJpeg, isExpired } from "./photo.js";

// Storage port. The real adapter (lib/blob-store.ts) wraps @vercel/blob;
// tests use an in-memory fake. Keeping this file free of @vercel/blob lets it run under node:test.
export interface Store {
  // "exists" means the path already held a photo and nothing was written. Never overwrites.
  put(path: string, b: Uint8Array): Promise<"stored" | "exists">;
  head(path: string): Promise<{ uploadedAt: Date } | null>;
  read(path: string): Promise<ReadableStream<Uint8Array> | null>;
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

// The id comes from the guest's QR link, so an existing photo is never replaced: a second upload gets 409.
export async function handlePut(req: { id: string; body: Uint8Array }, store: Store): Promise<number> {
  if (!isPhotoId(req.id)) return 400;
  if (req.body.byteLength > MAX_BYTES) return 413;
  if (!isJpeg(req.body)) return 415;
  const outcome = await store.put(photoPath(req.id), req.body);
  return outcome === "exists" ? 409 : 201;
}

// Returns the storage path of a live photo, or null. Never reads the bytes.
export async function resolvePhoto(id: string, store: Store, now: Date): Promise<string | null> {
  if (!isPhotoId(id)) return null;
  const path = photoPath(id);
  const found = await store.head(path);
  if (!found || isExpired(found.uploadedAt, now)) return null;
  return path;
}

// Streams a live photo. An expired or missing photo is never read from storage.
export async function openPhoto(
  id: string,
  store: Store,
  now: Date,
): Promise<ReadableStream<Uint8Array> | null> {
  const path = await resolvePhoto(id, store, now);
  if (!path) return null;
  return store.read(path);
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
