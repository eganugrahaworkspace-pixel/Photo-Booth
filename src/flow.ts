export type State = "idle" | "countdown" | "uploading" | "done" | "failed";
export type Event = "shoot" | "captured" | "uploaded" | "error" | "retry" | "next";

const TRANSITIONS: Partial<Record<State, Partial<Record<Event, State>>>> = {
  idle: { shoot: "countdown" },
  countdown: { captured: "uploading", error: "idle" },
  uploading: { uploaded: "done", error: "failed" },
  failed: { retry: "uploading", next: "idle" },
  done: { next: "idle" },
};

// Unlisted (state, event) pairs keep the current state, so a double tap
// on "shoot" mid-countdown cannot start a second photo.
export function next(s: State, e: Event): State {
  return TRANSITIONS[s]?.[e] ?? s;
}
