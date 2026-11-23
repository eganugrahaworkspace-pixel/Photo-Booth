import test from "node:test";
import assert from "node:assert/strict";
import type * as Camera from "../src/camera.ts";

// Each test loads a fresh copy of camera.ts: its state is module-level and has no reset.
let caseId = 0;
async function loadCamera(): Promise<typeof Camera> {
  return (await import(`../src/camera.ts?case=${++caseId}`)) as typeof Camera;
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

class FakeTrack extends EventTarget {
  kind = "video";
  readyState: "live" | "ended" = "live";
  muted = false;
  stopped = false;
  constructor(readonly deviceId: string) {
    super();
  }
  stop(): void {
    this.stopped = true;
    this.readyState = "ended";
  }
  getSettings(): { deviceId: string } {
    return { deviceId: this.deviceId };
  }
  fire(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[]) {}
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
}

function makeStream(id: string): { stream: FakeMediaStream; track: FakeTrack } {
  const track = new FakeTrack(id);
  return { stream: new FakeMediaStream([track]), track };
}

function fakeVideo(): HTMLVideoElement & { plays: Deferred<void>[] } {
  const plays: Deferred<void>[] = [];
  return {
    srcObject: null,
    muted: false,
    playsInline: false,
    plays,
    play() {
      const d = deferred<void>();
      plays.push(d);
      return d.promise;
    },
  } as unknown as HTMLVideoElement & { plays: Deferred<void>[] };
}

// Stubs the browser globals camera.ts touches. getUserMedia calls are queued so tests decide the order they settle.
function installBrowser(): {
  gum: Deferred<FakeMediaStream>[];
  visibilityListeners: Array<() => void>;
  doc: { visibilityState: string };
} {
  const gum: Deferred<FakeMediaStream>[] = [];
  const visibilityListeners: Array<() => void> = [];
  const doc = {
    visibilityState: "visible",
    addEventListener(type: string, fn: () => void) {
      if (type === "visibilitychange") visibilityListeners.push(fn);
    },
  };
  Object.defineProperty(globalThis, "document", { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: () => {
          const d = deferred<FakeMediaStream>();
          gum.push(d);
          return d.promise;
        },
        enumerateDevices: async () => [],
      },
    },
    configurable: true,
    writable: true,
  });
  Object.assign(globalThis, { MediaStream: FakeMediaStream });
  return { gum, visibilityListeners, doc };
}

test("(a) unmute dari track lama saat restart tidak melaporkan kamera siap", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();
  const old = makeStream("old");

  const first = cam.startCamera(video);
  gum[0].resolve(old.stream);
  await flush();
  video.plays[0].resolve();
  await first;

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));
  const restart = cam.restartCamera();
  await flush();
  const mark = calls.length;

  // The old track is still the video's track until the replacement is attached.
  old.track.fire("unmute");
  assert.equal(calls.slice(mark).includes(true), false);

  gum[1].resolve(makeStream("new").stream);
  await flush();
  video.plays[1].resolve();
  await restart;
});

test("(a2) unmute dari track lama saat restart tertunda (hold) tidak melaporkan kamera siap", { timeout: 3000 }, async () => {
  const { gum, visibilityListeners, doc } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();
  const old = makeStream("old");

  const first = cam.startCamera(video);
  gum[0].resolve(old.stream);
  await flush();
  video.plays[0].resolve();
  await first;

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));
  cam.setCameraHold(true);
  doc.visibilityState = "visible";
  for (const fn of visibilityListeners) fn();
  const mark = calls.length;

  old.track.fire("unmute");
  assert.equal(calls.slice(mark).includes(true), false);
});

test("(b) dua start yang tumpang tindih: stream usang dihentikan, stream terbaru tampil", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();
  const staleA = makeStream("a");
  const latestB = makeStream("b");

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));

  const pA = cam.startCamera(video);
  const pB = cam.startCamera(video);
  await flush();

  // B settles first, then the stale A arrives.
  gum[1].resolve(latestB.stream);
  await flush();
  video.plays[0].resolve();
  await pB;

  gum[0].resolve(staleA.stream);
  await flush();
  await pA;

  assert.equal(video.srcObject, latestB.stream);
  assert.equal(staleA.track.stopped, true);
  assert.equal(latestB.track.stopped, false);
  assert.equal(calls.at(-1), true);
});

test("(c) penolakan play() dari start yang usang tidak dilempar ke pemanggil", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();

  const pA = cam.startCamera(video);
  gum[0].resolve(makeStream("a").stream);
  await flush();

  const pB = cam.startCamera(video);
  gum[1].resolve(makeStream("b").stream);
  await flush();
  video.plays[1].resolve();
  await pB;

  // The stale play() is interrupted by the newer load.
  video.plays[0].reject(new DOMException("interrupted", "AbortError"));
  await assert.doesNotReject(pA);
});

test("(a3) unmute dari track lama setelah restart gagal tidak melaporkan kamera siap", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();
  const old = makeStream("old");

  const first = cam.startCamera(video);
  gum[0].resolve(old.stream);
  await flush();
  video.plays[0].resolve();
  await first;

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));
  const restart = cam.restartCamera();
  await flush();
  gum[1].reject(new DOMException("busy", "NotReadableError"));
  await restart;
  const mark = calls.length;

  // The old track is still attached after the failed restart; its unmute must not re-enable shooting.
  old.track.fire("unmute");
  assert.equal(calls.slice(mark).includes(true), false);
  assert.equal(cam.isCameraUsable(video), false);
});

test("(b2) start yang berhasil setelah restart gagal melaporkan kamera siap", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();

  const first = cam.startCamera(video);
  gum[0].resolve(makeStream("old").stream);
  await flush();
  video.plays[0].resolve();
  await first;

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));
  const restart = cam.restartCamera();
  await flush();
  gum[1].reject(new DOMException("busy", "NotReadableError"));
  await restart;

  const next = cam.startCamera(video);
  gum[2].resolve(makeStream("new").stream);
  await flush();
  video.plays[1].resolve();
  assert.equal(await next, true);
  assert.equal(calls.at(-1), true);
  assert.equal(cam.isCameraUsable(video), true);
});

test("(c2) start pindah kamera yang gagal (bukan restart) tidak menandai kamera gagal", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();
  const old = makeStream("old");

  const first = cam.startCamera(video);
  gum[0].resolve(old.stream);
  await flush();
  video.plays[0].resolve();
  await first;

  const calls: boolean[] = [];
  cam.onCameraState((usable) => calls.push(usable));
  const sw = cam.startCamera(video, "other");
  await flush();
  gum[1].reject(new DOMException("busy", "NotReadableError"));
  await assert.rejects(sw);

  // The previous stream is deliberately kept, so its track events still report usable.
  const mark = calls.length;
  old.track.fire("unmute");
  assert.equal(calls.slice(mark).at(-1), true);
  assert.equal(cam.isCameraUsable(video), true);
});

test("(d) start yang tersusul mengembalikan false, start terbaru mengembalikan true", { timeout: 3000 }, async () => {
  const { gum } = installBrowser();
  const cam = await loadCamera();
  const video = fakeVideo();

  const pA = cam.startCamera(video);
  const pB = cam.startCamera(video);
  await flush();

  gum[1].resolve(makeStream("b").stream);
  await flush();
  video.plays[0].resolve();
  assert.equal(await pB, true);

  // The superseded grant arrives after the latest call has finished.
  gum[0].resolve(makeStream("a").stream);
  await flush();
  assert.equal(await pA, false);
});
