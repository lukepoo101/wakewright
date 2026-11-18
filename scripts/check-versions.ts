// Fail when a pinned tool version drifts from its single source of truth.
//
//   mise.toml [tools].bun       is the Bun version. The running Bun, the
//                               @types/bun devDependency and every oven/bun
//                               base image in deploy/docker must match it.
//   Bun's bundled TypeScript    is what `bun check` uses; the `typescript`
//                               devDependency (what editors use) must match.
//   mise.toml [tools].python    is the worker's Python, and [tools].uv its
//   and [tools].uv              uv. The worker Dockerfile's python and uv
//                               bases and apps/worker/pyproject.toml's
//                               requires-python, uv pin and uv_build must match.
//   apps/parent/package.json    is the product version. Every workspace
//                               package, the worker (pyproject.toml and
//                               uv.lock) and CHANGELOG.md's newest section
//                               must match it.
//
// Usage: bun scripts/check-versions.ts      Exit 0 when all agree, 1 otherwise.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pythonVersion } from "./release.ts";

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

// The worker's toolchain: mise.toml's python and uv are the versions. The
// worker image's python and uv bases, pyproject.toml's interpreter range,
// uv pin and build backend must agree with them.
const worker = join(root, "apps", "worker");
const pyproject = Bun.TOML.parse(await Bun.file(join(worker, "pyproject.toml")).text()) as {
  project?: { version?: string; "requires-python"?: string };
  "build-system"?: { requires?: string[] };
  tool?: { uv?: { "required-version"?: string } };
};
const python = mise.tools?.python;
const uv = mise.tools?.uv;
for (const [tool, value] of [
  ["python", python],
  ["uv", uv],
] as const) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value))
    errors.push(`mise.toml must pin [tools].${tool} to an exact version, found ${value}`);
}
if (typeof python === "string" && typeof uv === "string") {
  const minor = python.split(".").slice(0, 2).join(".");
  const [major = "", min = ""] = minor.split(".");
  const range = `>=${minor},<${major}.${Number(min) + 1}`;
  if (pyproject.project?.["requires-python"] !== range)
    errors.push(
      `apps/worker/pyproject.toml requires-python is ${pyproject.project?.["requires-python"]}, mise.toml's Python ${python} needs "${range}"`,
    );
  if (pyproject.tool?.uv?.["required-version"] !== `==${uv}`)
    errors.push(
      `apps/worker/pyproject.toml [tool.uv] required-version is ${pyproject.tool?.uv?.["required-version"]}, mise.toml pins uv ${uv}`,
    );
  if (!pyproject["build-system"]?.requires?.includes(`uv_build==${uv}`))
    errors.push(`apps/worker/pyproject.toml must build with uv_build==${uv} (mise.toml's uv)`);
  const dockerfile = await Bun.file(join(root, "deploy", "docker", "worker.Dockerfile")).text();
  const pythonTags = [...dockerfile.matchAll(/^FROM\s+python:([^\s@-]+)/gm)].map((m) => m[1]);
  const uvTags = [...dockerfile.matchAll(/^FROM\s+ghcr\.io\/astral-sh\/uv:([^\s@]+)/gm)].map(
    (m) => m[1],
  );
  if (!pythonTags.length || pythonTags.some((t) => t !== python))
    errors.push(
      `deploy/docker/worker.Dockerfile uses python:${pythonTags}, mise.toml pins ${python}`,
    );
  if (!uvTags.length || uvTags.some((t) => t !== uv))
    errors.push(`deploy/docker/worker.Dockerfile uses uv:${uvTags}, mise.toml pins ${uv}`);
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
// The worker is released with the parent under the same version.
const pep440 = pythonVersion(product);
if (pyproject.project?.version !== pep440)
  errors.push(
    `apps/worker/pyproject.toml is version ${pyproject.project?.version}, apps/parent is ${product}`,
  );
const uvLock = Bun.TOML.parse(await Bun.file(join(worker, "uv.lock")).text()) as {
  package?: { name: string; version: string }[];
};
const locked = uvLock.package?.find((p) => p.name === "wakewright-worker")?.version;
if (locked !== pep440)
  errors.push(
    `apps/worker/uv.lock has wakewright-worker ${locked}; run \`uv lock\` in apps/worker`,
  );

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
    `check-versions: Bun ${bun}, TypeScript ${process.versions.typescript}, Python ${python} and uv ${uv} agree; version ${product}`,
  );
}
