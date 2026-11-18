import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";

// Device and collection queries shared by several screens.

export type Device = InferResponseType<typeof v1.devices.$get, 200>["devices"][number];
export type Collection = InferResponseType<typeof v1.collection.$get, 200>;

export const devicesKey = ["devices"] as const;
export const collectionKey = ["collection"] as const;

export function useDevices() {
  return useQuery({
    queryKey: devicesKey,
    queryFn: () => call(v1.devices.$get()),
    // Faster while a new device waits for its first check.
    refetchInterval: (query) =>
      query.state.data?.devices.some((d) => d.status.health === "waiting") ? 1000 : 10_000,
  });
}

export function useCollection() {
  return useQuery({
    queryKey: collectionKey,
    queryFn: () => call(v1.collection.$get()),
    refetchInterval: 30_000,
  });
}

export function useSetPaused() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => call(v1.collection.$put({ json: { paused } })),
    onSuccess: (data) => {
      queryClient.setQueryData(collectionKey, data);
      void queryClient.invalidateQueries({ queryKey: devicesKey });
    },
  });
}

/** The server's message, unless it only repeats the advice's title. */
export function detailFor(code: string, message: string): string | null {
  const plain = (s: string) => s.toLowerCase().replace(/[.\s]+$/, "");
  return plain(message) === plain(adviceFor(code).title) ? null : message;
}

/** What went wrong, in words, and what to do about it. */
export function adviceFor(code: string): { title: string; fix: string } {
  switch (code) {
    case "unreachable":
      return {
        title: "Cannot connect to the device",
        fix: "Check the address and that the device is on and on the same network. Kiosk Satellite's remote administration must be running.",
      };
    case "timeout":
      return {
        title: "The device did not answer in time",
        fix: "It may be asleep, busy or on a weak Wi-Fi signal. Wakewright keeps trying.",
      };
    case "auth_failed":
      return {
        title: "The device rejected the password",
        fix: "Enter the remote administration password set in Kiosk Satellite.",
      };
    case "rate_limited":
      return {
        title: "The device is refusing logins for now",
        fix: "Too many wrong passwords were tried. Wait a few minutes, then check the password.",
      };
    case "bad_response":
      return {
        title: "The device's answer was not understood",
        fix: "Check that the address points at Kiosk Satellite (port 2324 by default) and that the app is up to date.",
      };
    case "secret_unreadable":
      return {
        title: "The stored password cannot be read",
        fix: "Wakewright's secret key changed. Edit the device and enter its password again.",
      };
    case "name_taken":
      return { title: "That name is in use", fix: "Choose another name for this device." };
    default:
      return { title: "Something went wrong", fix: "Try again; the server log has details." };
  }
}
