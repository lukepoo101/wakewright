import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call, v1 } from "./api.ts";

// The signed-in state: "setup" before the admin account exists, then
// "signed_out" or "signed_in"; always "open" when the server has sign-in off
// (WAKEWRIGHT__AUTH__MODE=none). Every screen sits behind it.

export const sessionKey = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: () => call(v1.session.$get()),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => call(v1.session.$delete()),
    // Drop every cached answer and re-read the session, which now says
    // "signed_out", so nothing from the account stays on screen.
    onSettled: () => queryClient.resetQueries(),
  });
}
