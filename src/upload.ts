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

// PUT the JPEG to the API. 409 means the photo is already stored (a retry after a lost response),
// so it counts as success. Throws UploadError for other non-2xx responses,
// a TypeError for network failures, and AbortError after 90 seconds without a response.
export async function uploadPhoto(id: string, jpeg: Blob): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/photo?id=${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "image/jpeg" },
      body: jpeg,
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 409) throw new UploadError(res.status);
  } finally {
    clearTimeout(timer);
  }
}
