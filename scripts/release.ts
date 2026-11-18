// Prepare a release: open the "Release X.Y.Z" pull request.
//
//   mise run release 0.0.1            open the pull request
//   mise run release 0.0.1 --dry-run  print the changelog section only
//
// The pull request sets every workspace package to the new version (and
// bun.lock with them) and adds the version's section to CHANGELOG.md:
// GitHub's generated release notes for the pull requests merged since the
// previous release, grouped by label (.github/release.yml). Edit the section
// in the pull request if it needs it. Merging the pull request is the
// release: on that commit, CI's publish job pushes the images and creates
// the tag and GitHub release with that section as its notes.
//
// Notes start from the newest earlier stable tag, so 0.0.1's section covers
// everything since 0.0.0, including what its release candidates had; the
// candidates' sections are replaced by it. A pre-release's notes start from
// the newest earlier tag of any kind.
//
// It needs `gh` signed in with write access, and works in a temporary Git
// worktree, so the current checkout is left as it is. See docs/RELEASING.md.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

// The tag release notes start from: the newest tag below `version`, stable
// only unless `version` is itself a pre-release.
export function previousTag(version: string, tags: string[]): string | undefined {
  return tags
    .filter((t) => VERSION.test(t.slice(1)) && t.startsWith("v"))
    .map((t) => t.slice(1))
    .filter((v) => Bun.semver.order(v, version) < 0)
    .filter((v) => isPrerelease(version) || !isPrerelease(v))
    .sort((a, b) => Bun.semver.order(b, a))
    .map((v) => `v${v}`)[0];
}

// GitHub's notes, reshaped into a CHANGELOG.md section.
export function section(version: string, date: string, notes: string): string {
  const body = notes
    .replace(/^## What's Changed\s*\n/m, "")
    .replace(/^## New Contributors/m, "### New contributors")
    .replace(/^\* /gm, "- ")
    .trim();
  return `## ${version} - ${date}\n\n${body || "No user-facing changes."}\n`;
}

// Insert `newSection` above the newest section, dropping the sections of
// this version's own release candidates when it is a stable release.
export function insert(changelog: string, version: string, newSection: string): string {
  const parts = changelog.split(/^(?=## )/m);
  const head = parts[0] ?? "";
  const sections = parts.slice(1).filter((s) => {
    const v = s.match(/^## (\S+)/)?.[1] ?? "";
    return !(v === version || (!isPrerelease(version) && v.startsWith(`${version}-`)));
  });
  return [`${head.trimEnd()}\n\n`, newSection, ...sections.map((s) => `\n${s.trimEnd()}\n`)]
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}

async function main(argv: string[]) {
  const dryRun = argv.includes("--dry-run");
  const version = argv.find((a) => !a.startsWith("--"));
  if (!version || !VERSION.test(version)) {
    console.error("usage: mise run release <X.Y.Z or X.Y.Z-rc.N> [--dry-run]");
    process.exit(2);
  }
  const repo = (await $`gh repo view --json nameWithOwner --jq .nameWithOwner`.text()).trim();
  await $`git fetch --quiet --tags origin main`;
  const tags = (await $`git tag --list ${"v*"}`.text()).split("\n").filter(Boolean);
  const newer = tags.find(
    (t) => VERSION.test(t.slice(1)) && Bun.semver.order(t.slice(1), version) >= 0,
  );
  if (newer) {
    console.error(`release: ${newer} already exists; pick a version above it`);
    process.exit(1);
  }
  const previous = previousTag(version, tags);
  if (!previous) {
    console.error("release: no earlier tag to start the notes from (v0.0.0 marks the start)");
    process.exit(1);
  }

  const notes =
    await $`gh api --method POST repos/${repo}/releases/generate-notes -f tag_name=v${version} -f target_commitish=main -f previous_tag_name=${previous} --jq .body`.text();
  const date = new Date().toISOString().slice(0, 10);
  const newSection = section(version, date, notes);
  console.log(`Changes since ${previous}:\n\n${newSection}`);
  if (dryRun) return;

  const branch = `release/v${version}`;
  const dir = mkdtempSync(join(tmpdir(), "wakewright-release-"));
  try {
    await $`git worktree add --quiet -b ${branch} ${dir} origin/main`;
    const root = (await Bun.file(join(dir, "package.json")).json()) as { workspaces: string[] };
    for (const pattern of root.workspaces) {
      for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(dir)) {
        const path = join(dir, file);
        const text = await Bun.file(path).text();
        await Bun.write(
          path,
          text.replace(/^ {2}"version": ".*",$/m, `  "version": "${version}",`),
        );
      }
    }
    await $`bun install --lockfile-only`.cwd(dir).quiet();
    const changelog = join(dir, "CHANGELOG.md");
    await Bun.write(changelog, insert(await Bun.file(changelog).text(), version, newSection));
    await $`bun fmt CHANGELOG.md`.cwd(dir).quiet();
    await $`bun scripts/check-versions.ts`.cwd(dir);
    await $`git add -A && git commit --quiet -m ${`Release ${version}`}`.cwd(dir);
    await $`git push --quiet -u origin ${branch}`.cwd(dir);
    const body = [
      `Merging this pull request releases ${version}${isPrerelease(version) ? " as a pre-release" : ""}: CI publishes the images and creates the \`v${version}\` tag and GitHub release, with the CHANGELOG.md section below as its notes.`,
      "",
      "Edit `CHANGELOG.md` on this branch to reword or regroup entries before merging. See docs/RELEASING.md.",
      "",
      newSection,
    ].join("\n");
    await $`gh pr create --repo ${repo} --head ${branch} --title ${`Release ${version}`} --label release --body ${body}`.cwd(
      dir,
    );
  } finally {
    await $`git worktree remove --force ${dir}`.nothrow().quiet();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main(Bun.argv.slice(2));
