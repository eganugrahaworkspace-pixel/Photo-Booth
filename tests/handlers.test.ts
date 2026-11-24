import test from "node:test";
import assert from "node:assert/strict";
import { handlePut, resolvePhoto, openPhoto, cleanup, isCronAuthorized, type Store } from "../lib/handlers.ts";
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
// `reads` records every path passed to read(), so tests can assert storage was never touched.
function fakeStore(clock: Date = NOW) {
  const files = new Map<string, Entry>();
  const dels: string[][] = [];
  const reads: string[] = [];
  const store: Store & {
    files: Map<string, Entry>;
    dels: string[][];
    reads: string[];
    seed(id: string, uploadedAt: Date): void;
  } = {
    files,
    dels,
    reads,
    seed(id, uploadedAt) {
      files.set(`photos/${id}.jpg`, { bytes: JPEG, uploadedAt });
    },
    async put(path, b) {
      if (files.has(path)) return "exists";
      files.set(path, { bytes: b, uploadedAt: clock });
      return "stored";
    },
    async head(path) {
      const f = files.get(path);
      return f ? { uploadedAt: f.uploadedAt } : null;
    },
    async read(path) {
      reads.push(path);
      const f = files.get(path);
      if (!f) return null;
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(f.bytes);
          c.close();
        },
      });
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

test("upload tanpa kunci apa pun tetap 201", async () => {
  const store = fakeStore();
  assert.equal(await handlePut({ id: ID, body: JPEG }, store), 201);
  assert.deepEqual(store.files.get(`photos/${ID}.jpg`)?.bytes, JPEG);
});
test("id ngawur 400", async () => {
  assert.equal(await handlePut({ id: "../a", body: JPEG }, fakeStore()), 400);
});
test("bukan jpeg 415", async () => {
  assert.equal(await handlePut({ id: ID, body: PNG }, fakeStore()), 415);
});
test("terlalu besar 413", async () => {
  assert.equal(await handlePut({ id: ID, body: HUGE_JPEG }, fakeStore()), 413);
});
test("urutan cek: id sebelum ukuran", async () => {
  assert.equal(await handlePut({ id: "../a", body: HUGE_JPEG }, fakeStore()), 400);
});
test("upload sah 201 dan tersimpan di photos/<id>.jpg", async () => {
  const store = fakeStore();
  assert.equal(await handlePut({ id: ID, body: JPEG }, store), 201);
  assert.deepEqual(store.files.get(`photos/${ID}.jpg`)?.bytes, JPEG);
});
test("upload kedua ke id yang sama 409 dan byte pertama tetap", async () => {
  const store = fakeStore();
  const first = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
  const second = new Uint8Array([0xff, 0xd8, 0xff, 0x02, 0x03]);
  assert.equal(await handlePut({ id: ID, body: first }, store), 201);
  assert.equal(await handlePut({ id: ID, body: second }, store), 409);
  assert.deepEqual(store.files.get(`photos/${ID}.jpg`)?.bytes, first);
  assert.equal((await store.list()).length, 1);
});
test("kegagalan storage selain already-exists dilempar, bukan 409", async () => {
  const store = fakeStore();
  store.put = async () => {
    throw new Error("storage down");
  };
  await assert.rejects(handlePut({ id: ID, body: JPEG }, store), /storage down/);
});
test("resolvePhoto mengembalikan path untuk foto segar", async () => {
  const store = fakeStore();
  await handlePut({ id: ID, body: JPEG }, store);
  assert.equal(await resolvePhoto(ID, store, NOW), `photos/${ID}.jpg`);
  assert.equal(store.reads.length, 0);
});
test("openPhoto mengalirkan isi foto segar", async () => {
  const store = fakeStore();
  await handlePut({ id: ID, body: JPEG }, store);
  const stream = await openPhoto(ID, store, NOW);
  assert.ok(stream);
  assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()), JPEG);
  assert.deepEqual(store.reads, [`photos/${ID}.jpg`]);
});
test("openPhoto untuk id ngawur atau tidak ada tidak membaca storage", async () => {
  const store = fakeStore();
  assert.equal(await openPhoto("../a", store, NOW), null);
  assert.equal(await openPhoto(ID, store, NOW), null);
  assert.equal(store.reads.length, 0);
});
test("foto kedaluwarsa tidak pernah dibaca dari storage", async () => {
  const store = fakeStore();
  store.seed(OLD_ID, new Date(NOW.getTime() - RETENTION_MS - 1));
  assert.equal(await openPhoto(OLD_ID, store, NOW), null);
  assert.equal(store.reads.length, 0);
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
