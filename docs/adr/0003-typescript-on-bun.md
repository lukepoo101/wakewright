# 0003 TypeScript on Bun for the parent

- Status: accepted
- Date: 2026-11-17

## Context

The parent is an HTTP server, a SQLite application and a web UI. The
workers need Python's ML ecosystem. One language for the parent's server
and UI keeps it small and lets the UI be typed from the server.

## Decision

The parent is TypeScript on **Bun 1.4.4**, used for as much as possible:
runtime, `bun install` (text `bun.lock`, workspaces), `bun build`,
`bun test`, `bun check`, `bun fmt`, `bun:sqlite`, `Bun.password` and
`Bun.serve`. Another tool is added only for a verified Bun gap. Workers
stay Python 3.13 (TensorFlow 2.21 has no wheels above cp313). Node.js 26 was
the runner-up.

The server sticks to Web-standard APIs (Hono, `fetch`, `Request`,
`Response`, `crypto.subtle`), so moving to Node would mean replacing
`bun:sqlite`, `Bun.password` and `Bun.serve` and little else.

## Consequences

Contributors need two toolchains once workers arrive; mise pins both. The
parent–worker protocol is defined in TypeScript (zod) and generated for
Python. Bun is younger than Node and has one corporate sponsor; we accept
that risk.
