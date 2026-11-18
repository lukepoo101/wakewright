// The pairing string: the parent's address and a worker's token in one
// value, so a worker needs a single paste (ADR 0018, docs/workers.md).
//
//   wakewright-pair:1:<base64url of {"url": "...", "token": "..."}>
//
// `1` is the format's version. The JSON is UTF-8, base64url without
// padding. A worker that reads a newer version must refuse it by name. The
// string holds the token, so treat it as a secret and never log it.
//
// Pure and dependency-free: the SPA builds the string, the fake worker
// reads it, and the Python worker has its own reader (config.py) tested
// against the same examples.

export const PAIRING_PREFIX = "wakewright-pair:";
export const PAIRING_VERSION = 1;

export interface Pairing {
  /** The parent's address, http(s), without a trailing slash. */
  url: string;
  token: string;
}

export function encodePairing(pairing: Pairing): string {
  const json = JSON.stringify({ url: trimSlashes(pairing.url), token: pairing.token });
  const b64 = new TextEncoder().encode(json).toBase64({ alphabet: "base64url", omitPadding: true });
  return `${PAIRING_PREFIX}${PAIRING_VERSION}:${b64}`;
}

/** Reads a pairing string; throws an Error saying what is wrong with it. */
export function decodePairing(text: string): Pairing {
  const value = text.trim();
  if (!value.startsWith(PAIRING_PREFIX)) {
    throw new Error(`a pairing string starts with "${PAIRING_PREFIX}"`);
  }
  const rest = value.slice(PAIRING_PREFIX.length);
  const colon = rest.indexOf(":");
  const version = colon < 0 ? rest : rest.slice(0, colon);
  if (version !== String(PAIRING_VERSION)) {
    throw new Error(
      `this pairing string is format ${version || "?"}; this program reads format ${PAIRING_VERSION}`,
    );
  }
  let data: unknown;
  try {
    const bytes = Uint8Array.fromBase64(rest.slice(colon + 1), { alphabet: "base64url" });
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("the pairing string is damaged: copy it again");
  }
  const { url, token } = (data ?? {}) as { url?: unknown; token?: unknown };
  if (typeof url !== "string" || !/^https?:\/\/[^/]/.test(url)) {
    throw new Error("the pairing string has no http:// or https:// address");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("the pairing string has no token");
  }
  return { url: trimSlashes(url), token };
}

// Without a regular expression, which would be slow on many slashes.
function trimSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}
