import { encodePairing } from "@wakewright/parent/pairing";
import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";
import { ago } from "./format.ts";
import { judgeName } from "./judging.ts";

// Workers: the programs that judge clips, each a record with its own
// token, created here or declared in the server's configuration.

export type WorkerList = InferResponseType<typeof v1.workers.$get, 200>;
export type Worker = WorkerList["workers"][number];

export const workersKey = ["workers"] as const;

export function useWorkers() {
  return useQuery({
    queryKey: workersKey,
    queryFn: () => call(v1.workers.$get()),
    refetchInterval: 5_000,
  });
}

/** For its status mark: connected, paused, never connected, or gone quiet. */
export type WorkerState = "ok" | "paused" | "waiting" | "failing";

export function workerState(w: Worker): WorkerState {
  if (!w.enabled) return "paused";
  if (w.connected) return "ok";
  return w.reported.lastSeenAt ? "failing" : "waiting";
}

/** The worker's state in words. */
export function workerStatusText(w: Worker, now: number): string {
  const seen = w.reported.lastSeenAt;
  switch (workerState(w)) {
    case "paused":
      return w.connected ? "Paused · connected, gets no clips" : "Paused";
    case "ok":
      return "Connected";
    case "waiting":
      return "Never connected";
    case "failing":
      return `Not connected · last seen ${ago(seen, now)}`;
  }
}

/** "All judges", or the allowed judges by their usual names. */
export function allowedText(w: Pick<Worker, "allowedJudges">): string {
  return w.allowedJudges === null
    ? "All judges"
    : w.allowedJudges.map(judgeName).join(", ") || "None";
}

/** The pairing string a worker needs: this server's address and its token. */
export function pairingString(address: string, token: string): string {
  return encodePairing({ url: address.trim(), token });
}

/** The address to suggest: the configured public URL, or the one in the browser. */
export function suggestedAddress(publicUrl: string | null): string {
  return publicUrl ?? window.location.origin;
}

/** Whether `address` can go in a pairing string. */
export function validAddress(address: string): boolean {
  try {
    const url = new URL(address.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
  } catch {
    return false;
  }
}

/** The commands that start Wakewright's worker with a pairing string. */
export function startCommands(pairing: string, version: string) {
  const tag = /^\d+\.\d+\.\d+/.test(version) ? version : "latest";
  return {
    docker: [
      "docker run -d --name wakewright-worker --restart unless-stopped \\",
      "  -v wakewright-worker-cache:/cache \\",
      `  -e WAKEWRIGHT_WORKER__PAIRING='${pairing}' \\`,
      `  ghcr.io/lukepoo101/wakewright-worker:${tag}`,
    ].join("\n"),
    uv: `uv run --frozen wakewright-worker run --pairing '${pairing}'`,
  };
}

/**
 * Copies text to the clipboard. The Clipboard API needs a secure context
 * (https or localhost), so over plain http a hidden text area is copied
 * instead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the fallback
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  const host = document.querySelector("dialog[open]") ?? document.body;
  host.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
