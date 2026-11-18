// Fail when a pinned tool version drifts from its single source of truth.
//
//   mise.toml [tools].bun       is the Bun version. The running Bun, the
//                               @types/bun devDependency and every oven/bun
//                               base image in deploy/docker must match it.
//   Bun's bundled TypeScript    is what `bun check` uses; the `typescript`
//                               devDependency (what editors use) must match.
//   apps/parent/package.json    is the product version. Every workspace
//                               package and CHANGELOG.md's newest section
//                               must match it.
//
// Usage: bun scripts/check-versions.ts      Exit 0 when all agree, 1 otherwise.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const errors: string[] = [];

const mise = Bun.TOML.parse(await Bun.file(join(root, "mise.toml")).text()) as {
  tools?: Record<string, unknown>;
};
const bun = mise.tools?.bun;
if (typeof bun !== "string" || !/^\d+\.\d+\.\d+$/.test(bun)) {
  errors.push(`mise.toml must pin [tools].bun to an exact version, found ${JSON.stringify(bun)}`);
} else {
  if (Bun.version !== bun) errors.push(`Bun ${Bun.version} is running, but mise.toml pins ${bun}`);

  const manifest = await Bun.file(join(root, "package.json")).json();
  const types = manifest.devDependencies?.["@types/bun"];
  if (types !== bun)
    errors.push(`package.json pins @types/bun ${types}, mise.toml pins Bun ${bun}`);

  const dockerDir = join(root, "deploy", "docker");
  for (const file of readdirSync(dockerDir).filter((f) => f.endsWith("Dockerfile"))) {
    const text = await Bun.file(join(dockerDir, file)).text();
    for (const [, tag] of text.matchAll(/^FROM\s+oven\/bun:([^\s@]+)/gm)) {
      if (tag?.split("-")[0] !== bun)
        errors.push(`deploy/docker/${file} uses oven/bun:${tag}, mise.toml pins Bun ${bun}`);
    }
  }

  const typescript = manifest.devDependencies?.typescript;
  const bundled = process.versions.typescript;
  if (!bundled) errors.push(`Bun ${Bun.version} reports no bundled TypeScript`);
  else if (typescript !== bundled)
    errors.push(
      `bun check uses TypeScript ${bundled}, but package.json pins typescript ${typescript}; ` +
        "upgrade Bun and the typescript devDependency together",
    );
}

// The product version: apps/parent/package.json (the server reports it).
// Every workspace package carries the same version, and CHANGELOG.md's
// newest section is that version once anything has been released.
// `mise run release` changes them together.
const product = (await Bun.file(join(root, "apps", "parent", "package.json")).json()).version;
const rootManifest = await Bun.file(join(root, "package.json")).json();
for (const pattern of rootManifest.workspaces ?? []) {
  for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(root)) {
    const { name, version } = await Bun.file(join(root, file)).json();
    if (version !== product)
      errors.push(`${file} (${name}) is version ${version}, apps/parent is ${product}`);
  }
}
const changelog = await Bun.file(join(root, "CHANGELOG.md")).text();
const newest = changelog.match(/^## (\S+)/m)?.[1];
if (product === "0.0.0") {
  if (newest) errors.push(`CHANGELOG.md has a ${newest} section, but the version is 0.0.0`);
} else if (newest !== product) {
  errors.push(`CHANGELOG.md's newest section is ${newest ?? "missing"}, the version is ${product}`);
}

if (errors.length) {
  for (const e of errors) console.error(`check-versions: ${e}`);
  process.exitCode = 1;
} else {
  console.log(
    `check-versions: Bun ${bun} and TypeScript ${process.versions.typescript} agree; version ${product}`,
  );
}
