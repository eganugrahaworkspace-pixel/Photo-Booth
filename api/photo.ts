import { MAX_BYTES } from "../lib/photo.js";
import { handlePut, openPhoto } from "../lib/handlers.js";
import { blobStore } from "../lib/blob-store.js";

// Reads at most MAX_BYTES + 1 bytes. A longer body is cut short, which still fails the size check in handlePut.
// A declared content-length over the limit is never read at all.
async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    await request.body?.cancel();
    return new Uint8Array(MAX_BYTES + 1);
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total > MAX_BYTES) await reader.cancel();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function PUT(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const status = await handlePut({ id, body: await readBody(request) }, blobStore);
  return new Response(null, { status });
}

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  let stream: ReadableStream<Uint8Array> | null;
  try {
    stream = await openPhoto(id, blobStore, new Date());
  } catch {
    return new Response(null, { status: 502 });
  }
  if (!stream) return new Response(null, { status: 404 });
  return new Response(stream, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
    },
  });
}
