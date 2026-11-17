// Fail when an installed dependency's licence is not on the allow list.
//
// Wakewright is Apache-2.0 and ships its dependencies inside the image, so
// every package must carry a licence that lets us redistribute it without
// changing ours. The allow list is permissive licences only; anything else
// (copyleft, "UNLICENSED", a missing field) fails, and the fix is a
// decision: replace the package, or add the licence here with a reason in
// the same pull request.
//
// It reads the package.json of every package that `bun install` placed in
// node_modules/.bun (the isolated linker's store), so it runs offline and
// sees exactly what was installed. Optional platform packages for other
// operating systems are not installed and so not checked; they come from the
// same projects as the packages that are.
//
// Usage: bun scripts/check-licences.ts    Exit 0 when all pass, 1 otherwise,
//                                          2 when node_modules is missing.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

const store = join(import.meta.dir, "..", "node_modules", ".bun");
if (!existsSync(store)) {
  console.error("check-licences: node_modules/.bun is missing; run `mise run setup` first");
  process.exit(2);
}

// SPDX expression check without a parser dependency: an expression passes
// when at least one OR branch has only allowed licences. Parentheses are
// flattened, which is exact for the shapes npm packages use
// ("MIT", "(MIT OR Apache-2.0)", "Apache-2.0 AND MIT").
export function allowed(expression: string): boolean {
  const flat = expression.replace(/[()]/g, " ").trim();
  if (!flat) return false;
  return flat
    .split(/\s+OR\s+/)
    .some((branch) => branch.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

function licenceOf(manifest: { license?: unknown; licenses?: unknown }): string {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license === "object" && "type" in manifest.license)
    return String((manifest.license as { type: unknown }).type);
  if (Array.isArray(manifest.licenses))
    return manifest.licenses.map((l: { type?: string }) => l.type ?? "").join(" OR ");
  return "";
}

if (import.meta.main) {
  const failures: string[] = [];
  let checked = 0;
  for (const entry of readdirSync(store)) {
    const modules = join(store, entry, "node_modules");
    if (!existsSync(modules)) continue;
    // The store entry's own package sits at node_modules/<name> (or
    // node_modules/@scope/<name>) next to links to its dependencies, which
    // are checked under their own entries.
    const name = entry.startsWith("@")
      ? entry.slice(0, entry.indexOf("@", 1)).replace("+", "/")
      : entry.slice(0, entry.indexOf("@"));
    const file = join(modules, name, "package.json");
    if (!existsSync(file)) continue;
    const manifest = await Bun.file(file).json();
    const licence = licenceOf(manifest);
    checked++;
    if (!allowed(licence))
      failures.push(`${manifest.name}@${manifest.version}: ${licence || "no licence field"}`);
  }

  if (failures.length) {
    for (const f of failures) console.error(`check-licences: not allowed: ${f}`);
    console.error("check-licences: see scripts/check-licences.ts for the policy");
    process.exitCode = 1;
  } else {
    console.log(`check-licences: ${checked} packages, all under allowed licences`);
  }
}
