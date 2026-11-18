import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";
import { devicesKey } from "./devices.ts";
import { plural } from "./format.ts";

// Collection sessions (ADR 0020): for a time limit, one device wakes on
// almost anything and Wakewright keeps every clip, then puts the device's
// settings back and confirms them.

export type Session = InferResponseType<
  (typeof v1)["collection-sessions"]["$get"],
  200
>["sessions"][number];
export type SessionWrite = InferResponseType<
  (typeof v1)["collection-sessions"][":id"]["$get"],
  200
>["writes"][number];
export type OptionsResult = InferResponseType<
  (typeof v1.devices)[":id"]["collection-options"]["$get"],
  200
>;
export type CollectionOptions = Extract<OptionsResult, { ok: true }>["options"];
export type Note = NonNullable<Session["note"]>;

export const sessionsKey = ["collection-sessions"] as const;

export const NOTE_LABELS: Record<Note, string> = {
  wake_word: "Saying the wake word",
  not_wake_word: "Not saying it (talking, TV)",
  mixed: "Mixed",
};

/** Time limits offered, in minutes. */
export const LIMIT_CHOICES = [2, 5, 10, 15, 20, 30, 45, 60] as const;
export const DEFAULT_LIMIT_MINUTES = 10;

const OPEN = new Set<Session["state"]>(["starting", "running", "restoring", "needs_attention"]);

export function isOpen(s: Session): boolean {
  return OPEN.has(s.state);
}

/** Sessions newest first; polled quickly while one is open. */
export function useSessions(deviceId?: string) {
  return useQuery({
    queryKey: [...sessionsKey, deviceId ?? "all"],
    queryFn: () =>
      call(v1["collection-sessions"].$get({ query: deviceId ? { device: deviceId } : {} })),
    refetchInterval: (query) => (query.state.data?.sessions.some(isOpen) ? 2000 : 15_000),
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: [...sessionsKey, "one", id],
    queryFn: () => call(v1["collection-sessions"][":id"].$get({ param: { id } })),
    refetchInterval: (query) => {
      const s = query.state.data?.session;
      return s && isOpen(s) ? 2000 : false;
    },
  });
}

/** Reads the device now: what a session would change on it. */
export function useCollectionOptions(deviceId: string | undefined) {
  return useQuery({
    queryKey: [...sessionsKey, "options", deviceId],
    queryFn: () =>
      call(v1.devices[":id"]["collection-options"].$get({ param: { id: deviceId ?? "" } })),
    enabled: Boolean(deviceId),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

function useSessionAction(
  action: (id: string) => Promise<unknown>,
): ReturnType<typeof useMutation<unknown, Error, string>> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: action,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
      await queryClient.invalidateQueries({ queryKey: devicesKey });
    },
  });
}

export function useStopSession() {
  return useSessionAction((id) =>
    call(v1["collection-sessions"][":id"].stop.$post({ param: { id } })),
  );
}

export function useRetryRestore() {
  return useSessionAction((id) =>
    call(v1["collection-sessions"][":id"].retry.$post({ param: { id } })),
  );
}

export function useResolveByHand() {
  return useSessionAction((id) =>
    call(v1["collection-sessions"][":id"].resolve.$post({ param: { id } })),
  );
}

/** "4:05" for seconds left. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** How long a session ran, in words. */
export function durationText(s: Session): string {
  const start = s.startedAt ?? s.createdAt;
  const end = s.restoreStartedAt ?? s.endedAt;
  if (!s.startedAt) return "did not start";
  if (!end) return "running";
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (seconds < 90) return plural(seconds, "second");
  return plural(Math.round(seconds / 60), "minute");
}

/** How it ended, in words. */
export function endText(s: Session): string {
  switch (s.state) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "restoring":
      return "Putting the settings back";
    case "needs_attention":
      return "Needs you: put the settings back by hand";
  }
  switch (s.endReason) {
    case "stopped":
      return "Stopped";
    case "time_limit":
      return "Time limit reached";
    case "paused":
      return "Collection was paused";
    case "parent_restart":
      return "Wakewright restarted during it";
    case "start_failed":
      return "Did not start";
    default:
      return "Ended";
  }
}

/** Whether the device's settings are known to be back as they were. */
export function restoreText(s: Session): string {
  if (s.resolvedByHandAt) return "Put back by hand";
  if (s.restoredAt) {
    return s.changes.length === 0 ? "Nothing needed changing" : "Put back and confirmed";
  }
  if (s.state === "running" || s.state === "starting") return "Boosted now";
  if (s.state === "needs_attention") return "Not put back";
  return "Not confirmed yet";
}

/** "Wake word engine microWakeWord, Wake word sensitivity Very sensitive". */
export function changesText(s: Session, side: "from" | "to"): string {
  return s.changes.map((c) => `${c.title} ${side === "from" ? c.fromLabel : c.toLabel}`).join(", ");
}
