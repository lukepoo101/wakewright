import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";

// Clip queries, and the filter kept in the URL's search parameters so a
// filtered list can be bookmarked and survives a reload.

export type Clip = InferResponseType<(typeof v1.clips)[":id"]["$get"], 200>["clip"];

/** Search parameters of the Clips and Clip screens. Dates are local YYYY-MM-DD. */
export interface ClipSearch {
  device?: string;
  kind?: "fired" | "near_miss";
  from?: string;
  to?: string;
  page?: number;
}

/** Keeps the parameters that are valid and drops the rest. */
export function parseClipSearch(raw: Record<string, unknown>): ClipSearch {
  const date = (v: unknown) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  const page = Number(raw.page);
  return {
    device: typeof raw.device === "string" && raw.device ? raw.device : undefined,
    kind: raw.kind === "fired" || raw.kind === "near_miss" ? raw.kind : undefined,
    from: date(raw.from),
    to: date(raw.to),
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  };
}

export const PAGE_SIZE = 25;

/** The API's filter: local days become UTC instants (`to` is inclusive). */
export function apiFilter(search: ClipSearch) {
  const day = (d: string, plusDays = 0) => {
    const date = new Date(`${d}T00:00:00`);
    date.setDate(date.getDate() + plusDays);
    return date.toISOString();
  };
  return {
    ...(search.device ? { device: search.device } : {}),
    ...(search.kind ? { kind: search.kind } : {}),
    ...(search.from ? { from: day(search.from) } : {}),
    ...(search.to ? { to: day(search.to, 1) } : {}),
  };
}

export function useClips(search: ClipSearch, pageSize = PAGE_SIZE) {
  return useQuery({
    queryKey: ["clips", search, pageSize],
    queryFn: () =>
      call(
        v1.clips.$get({
          query: {
            ...apiFilter(search),
            page: String(search.page ?? 1),
            pageSize: String(pageSize),
          },
        }),
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}

export function useClip(id: string, search: ClipSearch) {
  return useQuery({
    queryKey: ["clip", id, search],
    queryFn: () => call(v1.clips[":id"].$get({ param: { id }, query: apiFilter(search) })),
  });
}

export function useClipSummary() {
  return useQuery({
    queryKey: ["clips", "summary"],
    queryFn: () => call(v1.clips.summary.$get()),
    refetchInterval: 15_000,
  });
}

export function audioUrl(id: string, download = false): string {
  return `/api/v1/clips/${encodeURIComponent(id)}/audio${download ? "?download=1" : ""}`;
}

export function kindLabel(kind: Clip["kind"]): string {
  return kind === "fired" ? "Wake word" : "Near miss";
}
