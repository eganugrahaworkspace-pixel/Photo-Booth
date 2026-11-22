import test from "node:test";
import assert from "node:assert/strict";
import { newPhotoId, isPhotoId, isJpeg, isExpired, RETENTION_MS } from "../lib/photo.ts";
import { coverCrop } from "../src/compose.ts";
import { next } from "../src/flow.ts";

test("id valid dan unik", () => {
  const a = newPhotoId();
  assert.ok(isPhotoId(a));
  assert.notEqual(a, newPhotoId());
  assert.equal(isPhotoId("../secret"), false);
});
test("isJpeg memeriksa magic bytes", () => {
  assert.equal(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isJpeg(new Uint8Array([])), false);
});
test("kedaluwarsa tepat setelah 7 hari", () => {
  const t = new Date(0);
  assert.equal(isExpired(t, new Date(RETENTION_MS)), false);
  assert.equal(isExpired(t, new Date(RETENTION_MS + 1)), true);
});
test("frame landscape di-crop tengah tanpa distorsi", () => {
  assert.deepEqual(coverCrop(1920, 1080, 1080, 1920), { sx: 656.25, sy: 0, sw: 607.5, sh: 1080 });
});
test("frame terlalu tinggi di-crop vertikal", () => {
  assert.deepEqual(coverCrop(1080, 2400, 1080, 1920), { sx: 0, sy: 240, sw: 1080, sh: 1920 });
});
test("tekan ganda tidak memicu foto kedua", () => {
  assert.equal(next("countdown", "shoot"), "countdown");
  assert.equal(next("uploading", "shoot"), "uploading");
});
test("gagal bisa dicoba lagi lalu selesai", () => {
  assert.equal(next("uploading", "error"), "failed");
  assert.equal(next("failed", "retry"), "uploading");
  assert.equal(next("uploading", "uploaded"), "done");
  assert.equal(next("done", "next"), "idle");
});
test("kamera gagal saat hitung mundur kembali ke idle", () => {
  assert.equal(next("countdown", "error"), "idle");
});
test("tanggal upload tidak valid dianggap kedaluwarsa", () => {
  assert.equal(isExpired(new Date(Number.NaN), new Date(0)), true);
});
