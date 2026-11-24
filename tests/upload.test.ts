import test from "node:test";
import assert from "node:assert/strict";
import { uploadPhoto, UploadError } from "../src/upload.ts";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const JPEG = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

function stubFetch(t: { mock: { method: Function } }, status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status });
  });
  return calls;
}

test("uploadPhoto tanpa header kunci apa pun", async (t) => {
  const calls = stubFetch(t, 201);
  await uploadPhoto(ID, JPEG);
  assert.equal(calls.length, 1);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.has("x-booth-key"), false);
  assert.equal(headers.get("content-type"), "image/jpeg");
});

test("uploadPhoto menganggap 409 sebagai sukses (foto sudah tersimpan)", async (t) => {
  stubFetch(t, 409);
  await assert.doesNotReject(uploadPhoto(ID, JPEG));
});

test("uploadPhoto tetap gagal untuk status lain", async (t) => {
  stubFetch(t, 500);
  await assert.rejects(uploadPhoto(ID, JPEG), (err: unknown) => err instanceof UploadError && err.status === 500);
});
