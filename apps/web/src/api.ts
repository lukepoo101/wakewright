import type { AppType } from "@wakewright/parent";
import { hc } from "hono/client";

// Typed client for the parent's API, built from the server's route types:
// no code generation. Same origin as the SPA.
export const api = hc<AppType>("/");
