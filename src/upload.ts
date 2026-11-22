// Venue networks are slow on the first byte; 30 seconds gave up on uploads that were still progressing.
const UPLOAD_TIMEOUT_MS = 90_000;

export class UploadError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Unggah gagal (${status})`);
    this.name = "UploadError";
    this.status = status;
  }
}

// PUT the JPEG to the API. Throws UploadError for any non-2xx response,
// a TypeError for network failures, and AbortError after 90 seconds without a response.
export async function uploadPhoto(id: string, jpeg: Blob, key: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/photo?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "x-booth-key": key, "content-type": "image/jpeg" },
      body: jpeg,
      signal: controller.signal,
    });
    if (!res.ok) throw new UploadError(res.status);
  } finally {
    clearTimeout(timer);
  }
}
