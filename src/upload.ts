export class UploadError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Unggah gagal (${status})`);
    this.name = "UploadError";
    this.status = status;
  }
}

// PUT the JPEG to the API. Throws UploadError for any non-2xx response,
// and a TypeError for network failures.
export async function uploadPhoto(id: string, jpeg: Blob, key: string): Promise<void> {
  const res = await fetch(`/api/photo?id=${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "x-booth-key": key, "content-type": "image/jpeg" },
    body: jpeg,
  });
  if (!res.ok) throw new UploadError(res.status);
}
