const SIZE = { width: { ideal: 1920 }, height: { ideal: 1080 } };

let activeVideo: HTMLVideoElement | null = null;
let activeDeviceId: string | undefined;
let wakeLock: WakeLockSentinel | null = null;
let watching = false;

export function currentDeviceId(video: HTMLVideoElement): string | undefined {
  const stream = video.srcObject;
  return stream instanceof MediaStream ? stream.getVideoTracks()[0]?.getSettings().deviceId : undefined;
}

// Opens the camera. The previous stream is only stopped once the new one is
// granted, so a failed switch leaves the current preview running.
export async function startCamera(video: HTMLVideoElement, deviceId?: string): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
      ...SIZE,
    },
    audio: false,
  });
  stopStream(video);
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();

  activeVideo = video;
  activeDeviceId = deviceId;
  await requestWakeLock();
  if (!watching) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    watching = true;
  }
}

// Only meaningful after camera permission is granted: labels and ids are blank before that.
export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
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

// Browsers stop the stream and the wake lock while the page is hidden.
async function onVisibilityChange(): Promise<void> {
  const video = activeVideo;
  if (document.visibilityState !== "visible" || !video) return;
  const stream = video.srcObject;
  const live = stream instanceof MediaStream && stream.getVideoTracks().some((t) => t.readyState === "live");
  if (live) {
    await video.play().catch(() => {});
    await requestWakeLock();
  } else {
    await startCamera(video, activeDeviceId).catch(() => {});
  }
}
