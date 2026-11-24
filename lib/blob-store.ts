import { put, head, get, list, del, BlobNotFoundError } from "@vercel/blob";
import type { Store } from "./handlers.js";

// Private store (must be created with Private access). Bytes are only reachable
// through the SDK with the server token, so GET /api/photo is the sole read path.
// addRandomSuffix off and allowOverwrite false: a photo id is never replaced once stored.
// @vercel/blob 2.9.0 exports no "already exists" error class, and the refused write does not
// carry a distinct code, so a failed put is checked with head(): the path holding a blob means
// "exists". Any other put failure, or a failing head(), is rethrown as a storage failure.
async function uploadedAt(path: string): Promise<Date | null> {
  try {
    return (await head(path)).uploadedAt;
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw err;
  }
}

export const blobStore: Store = {
  async put(path, b) {
    try {
      await put(path, Buffer.from(b.buffer, b.byteOffset, b.byteLength), {
        access: "private",
        contentType: "image/jpeg",
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return "stored";
    } catch (err) {
      if ((await uploadedAt(path)) !== null) return "exists";
      throw err;
    }
  },

  async head(path) {
    const at = await uploadedAt(path);
    return at === null ? null : { uploadedAt: at };
  },

  async read(path) {
    try {
      const result = await get(path, { access: "private" });
      if (!result || result.statusCode !== 200) return null;
      return result.stream;
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
  },

  // Follows the cursor until the store is exhausted, so no expired photo is missed.
  async list() {
    const out: { path: string; uploadedAt: Date }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: "photos/", cursor });
      for (const b of page.blobs) out.push({ path: b.pathname, uploadedAt: b.uploadedAt });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  },

  async del(paths) {
    await del(paths);
  },
};
