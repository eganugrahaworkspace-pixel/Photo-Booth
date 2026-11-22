import test from "node:test";
import assert from "node:assert/strict";
import { handlePut, resolvePhoto, cleanup, isCronAuthorized, type Store } from "../lib/handlers.ts";
import { MAX_BYTES, RETENTION_MS } from "../lib/photo.ts";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const OLD_ID = "BBBBBBBBBBBBBBBBBBBBBB";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const HUGE_JPEG = new Uint8Array(MAX_BYTES + 1);
HUGE_JPEG.set([0xff, 0xd8, 0xff]);
const NOW = new Date("2026-11-22T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

type Entry = { bytes: Uint8Array; uploadedAt: Date };

// In-memory Store. Fresh per test. `put` stamps uploads with `clock`.
function fakeStore(clock: Date = NOW) {
  const files = new Map<string, Entry>();
  const dels: string[][] = [];
  const store: Store & { files: Map<string, Entry>; dels: string[][]; seed(id: string, uploadedAt: Date): void } = {
    files,
    dels,
    seed(id, uploadedAt) {
      files.set(`photos/${id}.jpg`, { bytes: JPEG, uploadedAt });
    },
    async put(path, b) {
      files.set(path, { bytes: b, uploadedAt: clock });
    },
    async head(path) {
      const f = files.get(path);
      return f ? { uploadedAt: f.uploadedAt, url: `https://blob.test/${path}` } : null;
    },
    async list() {
      return [...files].map(([path, f]) => ({ path, uploadedAt: f.uploadedAt }));
    },
    async del(paths) {
      dels.push([...paths]);
      for (const p of paths) files.delete(p);
    },
  };
  return store;
}

test("kunci salah 401", async () => {
  assert.equal(await handlePut({ id: ID, key: "x", body: JPEG }, fakeStore(), "k"), 401);
});
test("kunci hilang atau BOOTH_KEY kosong 401", async () => {
  assert.equal(await handlePut({ id: ID, key: null, body: JPEG }, fakeStore(), "k"), 401);
  assert.equal(await handlePut({ id: ID, key: "", body: JPEG }, fakeStore(), ""), 401);
});
test("kunci dengan panjang berbeda tidak melempar", async () => {
  assert.equal(await handlePut({ id: ID, key: "kk", body: JPEG }, fakeStore(), "k"), 401);
});
test("id ngawur 400", async () => {
  assert.equal(await handlePut({ id: "../a", key: "k", body: JPEG }, fakeStore(), "k"), 400);
});
test("bukan jpeg 415", async () => {
  assert.equal(await handlePut({ id: ID, key: "k", body: PNG }, fakeStore(), "k"), 415);
});
test("terlalu besar 413", async () => {
  assert.equal(await handlePut({ id: ID, key: "k", body: HUGE_JPEG }, fakeStore(), "k"), 413);
});
test("urutan cek: kunci sebelum id, id sebelum ukuran", async () => {
  assert.equal(await handlePut({ id: "../a", key: "x", body: HUGE_JPEG }, fakeStore(), "k"), 401);
  assert.equal(await handlePut({ id: "../a", key: "k", body: HUGE_JPEG }, fakeStore(), "k"), 400);
});
test("upload sah 201 dan tersimpan di photos/<id>.jpg", async () => {
  const store = fakeStore();
  assert.equal(await handlePut({ id: ID, key: "k", body: JPEG }, store, "k"), 201);
  assert.deepEqual(store.files.get(`photos/${ID}.jpg`)?.bytes, JPEG);
});
test("retry id sama hanya satu file", async () => {
  const store = fakeStore();
  await handlePut({ id: ID, key: "k", body: JPEG }, store, "k");
  assert.equal(await handlePut({ id: ID, key: "k", body: JPEG }, store, "k"), 201);
  assert.equal((await store.list()).length, 1);
});
test("resolvePhoto mengembalikan url untuk foto segar", async () => {
  const store = fakeStore();
  await handlePut({ id: ID, key: "k", body: JPEG }, store, "k");
  assert.equal(await resolvePhoto(ID, store, NOW), `https://blob.test/photos/${ID}.jpg`);
});
test("resolvePhoto null untuk id ngawur atau tidak ada", async () => {
  const store = fakeStore();
  assert.equal(await resolvePhoto("../a", store, NOW), null);
  assert.equal(await resolvePhoto(ID, store, NOW), null);
});
test("foto kedaluwarsa tidak bisa dibuka", async () => {
  const store = fakeStore();
  store.seed(OLD_ID, new Date(NOW.getTime() - RETENTION_MS - 1));
  assert.equal(await resolvePhoto(OLD_ID, store, NOW), null);
});
test("cleanup hanya menghapus yang lewat 7 hari", async () => {
  const store = fakeStore();
  store.seed(ID, new Date(NOW.getTime() - DAY));
  store.seed(OLD_ID, new Date(NOW.getTime() - 8 * DAY));
  assert.equal(await cleanup(store, NOW), 1);
  assert.ok(await store.head(`photos/${ID}.jpg`));
  assert.equal(await store.head(`photos/${OLD_ID}.jpg`), null);
});
test("cleanup tanpa yang kedaluwarsa tidak memanggil del", async () => {
  const store = fakeStore();
  store.seed(ID, new Date(NOW.getTime() - DAY));
  assert.equal(await cleanup(store, NOW), 0);
  assert.equal(store.dels.length, 0);
});
test("cleanup menghapus semua yang kedaluwarsa dalam satu panggilan", async () => {
  const store = fakeStore();
  store.seed(OLD_ID, new Date(NOW.getTime() - 9 * DAY));
  store.seed("CCCCCCCCCCCCCCCCCCCCCC", new Date(NOW.getTime() - 10 * DAY));
  assert.equal(await cleanup(store, NOW), 2);
  assert.equal(store.dels.length, 1);
});
test("foto dengan uploadedAt tidak valid dianggap kedaluwarsa", async () => {
  const store = fakeStore();
  store.seed(OLD_ID, new Date(Number.NaN));
  assert.equal(await resolvePhoto(OLD_ID, store, NOW), null);
  assert.equal(await cleanup(store, NOW), 1);
});
test("cron: hanya Bearer yang benar lolos", () => {
  assert.equal(isCronAuthorized("Bearer s3cret", "s3cret"), true);
  assert.equal(isCronAuthorized("Bearer wrong", "s3cret"), false);
  assert.equal(isCronAuthorized("Bearer s3cret-longer", "s3cret"), false);
  assert.equal(isCronAuthorized("s3cret", "s3cret"), false);
  assert.equal(isCronAuthorized(null, "s3cret"), false);
  assert.equal(isCronAuthorized("Bearer ", ""), false);
  assert.equal(isCronAuthorized("Bearer ", undefined), false);
});
