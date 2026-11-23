const SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

let activeVideo: HTMLVideoElement | null = null;
let activeDeviceId: string | undefined;
let wakeLock: WakeLockSentinel | null = null;
let watching = false;
// While a shot is in progress the stream must not be replaced, or the video would clear mid-countdown.
let hold = false;
let pendingRestart = false;
// Bumped by every startCamera call; only the latest call may attach, clear `starting` and report.
let startToken = 0;
let starting = false;
// Set when a restart begins and cleared only when the latest start has its play() resolved: until then the video may hold a frozen frame.
let needsFreshStream = false;
let onState: ((usable: boolean) => void) | null = null;

export function onCameraState(cb: (usable: boolean) => void): void {
  onState = cb;
}

export function currentDeviceId(video: HTMLVideoElement): string | undefined {
  const stream = video.srcObject;
  return stream instanceof MediaStream ? stream.getVideoTracks()[0]?.getSettings().deviceId : undefined;
}

// A frame can be stale or black when the track has ended or is muted by the OS, so all of these must pass.
export function isCameraUsable(video: HTMLVideoElement): boolean {
  if (starting || pendingRestart || needsFreshStream || video.paused) return false;
  const stream = video.srcObject;
  const track = stream instanceof MediaStream ? stream.getVideoTracks()[0] : undefined;
  return !!track && track.readyState === "live" && !track.muted;
}

// Opens the camera. The previous stream is only stopped once the new one is
// granted, so a failed switch leaves the current preview running.
// Resolves true when this call was applied, false when a newer start superseded it.
export async function startCamera(video: HTMLVideoElement, deviceId?: string): Promise<boolean> {
  const token = ++startToken;
  starting = true;
  // A superseded call stops quietly: the latest call owns the video, the flag and the report.
  const stale = () => token !== startToken;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
        ...SIZE,
      },
      audio: false,
    });
  } catch (err) {
    if (stale()) return false;
    starting = false;
    throw err;
  }
  if (stale()) {
    stream.getTracks().forEach((t) => t.stop());
    return false;
  }

  stopStream(video);
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  watchTrack(video, stream.getVideoTracks()[0]);
  // Attached before play(), so a hide/show can restart the camera even when this first play() fails.
  activeVideo = video;
  activeDeviceId = deviceId;
  if (!watching) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    watching = true;
  }
  try {
    await video.play();
  } catch (err) {
    if (stale()) return false;
    starting = false;
    throw err;
  }
  if (stale()) return false;

  needsFreshStream = false;
  await requestWakeLock();
  if (stale()) return false;
  starting = false;
  emit(video);
  return true;
}

// Only meaningful after camera permission is granted: labels and ids are blank before that.
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

// Called by the booth whenever it is not idle, so an in-flight shot keeps its stream.
export function setCameraHold(held: boolean): void {
  hold = held;
  if (!held && pendingRestart) {
    pendingRestart = false;
    void restartCamera();
  }
}

export async function restartCamera(): Promise<void> {
  const video = activeVideo;
  if (!video) return;
  // Shooting stays off until the replacement stream is live; the old frame may be frozen.
  needsFreshStream = true;
  onState?.(false);
  const pending = startCamera(video, activeDeviceId);
  // startCamera takes its token synchronously, so this is the token of this restart.
  const token = startToken;
  try {
    await pending;
  } catch {
    // Only a latest start throws. A newer start that began since then owns the state now.
    if (token === startToken) onState?.(false);
  }
}

function watchTrack(video: HTMLVideoElement, track: MediaStreamTrack | undefined): void {
  if (!track) return;
  // An event from a track that is no longer the video's track (the old stream) must not report.
  const notify = () => {
    if (currentVideoTrack(video) === track) emit(video);
  };
  track.addEventListener("ended", notify);
  track.addEventListener("mute", notify);
  track.addEventListener("unmute", notify);
}

function currentVideoTrack(video: HTMLVideoElement): MediaStreamTrack | undefined {
  const stream = video.srcObject;
  return stream instanceof MediaStream ? stream.getVideoTracks()[0] : undefined;
}

// Silent while a start or a deferred restart is pending: the stream on the video is not the one to shoot from yet.
function emit(video: HTMLVideoElement): void {
  if (starting || pendingRestart) return;
  onState?.(isCameraUsable(video));
}

function stopStream(video: HTMLVideoElement): void {
  const stream = video.srcObject;
  if (stream instanceof MediaStream) stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

async function requestWakeLock(): Promise<void> {
  if (!navigator.wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

// Browsers stop the stream and the wake lock while the page is hidden, and
// iOS can leave a track "live" but frozen, so the stream is restarted on every return.
function onVisibilityChange(): void {
  if (document.visibilityState !== "visible" || !activeVideo) return;
  if (hold) {
    needsFreshStream = true;
    pendingRestart = true;
    // Not shootable until the deferred restart completes.
    onState?.(false);
    return;
  }
  void restartCamera();
}
