import { put, head, get, list, del, BlobNotFoundError } from "@vercel/blob";
import type { Store } from "./handlers.js";

// Private store (must be created with Private access). Bytes are only reachable
// through the SDK with the server token, so GET /api/photo is the sole read path.
// addRandomSuffix off + allowOverwrite make retries overwrite one file.
export const blobStore: Store = {
  async put(path, b) {
    await put(path, Buffer.from(b.buffer, b.byteOffset, b.byteLength), {
      access: "private",
      contentType: "image/jpeg",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },

  async head(path) {
    try {
      const meta = await head(path);
      return { uploadedAt: meta.uploadedAt };
    } catch (err) {
      if (err instanceof BlobNotFoundError) return null;
      throw err;
    }
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
