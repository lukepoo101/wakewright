import { expect, test } from "bun:test";
import { insert, previousTag, pythonVersion, section, setPythonVersion } from "./release.ts";

const tags = ["v0.0.0", "v0.0.1-rc.1", "v0.0.1-rc.2", "v0.0.1", "v0.1.0-rc.1"];

test("a stable release's notes start at the newest earlier stable tag", () => {
  expect(previousTag("0.0.1", ["v0.0.0", "v0.0.1-rc.1", "v0.0.1-rc.2"])).toBe("v0.0.0");
  expect(previousTag("0.1.0", tags)).toBe("v0.0.1");
});

test("a pre-release's notes start at the newest earlier tag of any kind", () => {
  expect(previousTag("0.0.1-rc.3", ["v0.0.0", "v0.0.1-rc.2"])).toBe("v0.0.1-rc.2");
  expect(previousTag("0.1.0-rc.2", tags)).toBe("v0.1.0-rc.1");
});

test("GitHub's notes become a changelog section", () => {
  const notes =
    "## What's Changed\n<!-- Release notes generated using configuration in .github/release.yml at main -->\n\n### Fixes\n* Fix a thing by @a in https://x/pull/1\n\n" +
    "## New Contributors\n* @a made their first contribution\n\n**Full Changelog**: https://x";
  expect(section("0.0.1", "2026-11-18", notes)).toBe(
    "## 0.0.1 - 2026-11-18\n\n### Fixes\n- Fix a thing by @a in https://x/pull/1\n\n" +
      "### New contributors\n- @a made their first contribution\n\n**Full Changelog**: https://x\n",
  );
});

test("a stable release replaces its own release candidates' sections", () => {
  const changelog = "# Changelog\n\nIntro.\n\n## 0.0.1-rc.1 - 2026-11-18\n\n- A\n";
  expect(insert(changelog, "0.0.1", "## 0.0.1 - 2026-11-20\n\n- A\n- B\n")).toBe(
    "# Changelog\n\nIntro.\n\n## 0.0.1 - 2026-11-20\n\n- A\n- B\n",
  );
});

test("a release goes above older releases and keeps them", () => {
  const changelog = "# Changelog\n\n## 0.0.1 - 2026-11-20\n\n- A\n";
  expect(insert(changelog, "0.0.2-rc.1", "## 0.0.2-rc.1 - 2026-11-21\n\n- B\n")).toBe(
    "# Changelog\n\n## 0.0.2-rc.1 - 2026-11-21\n\n- B\n\n## 0.0.1 - 2026-11-20\n\n- A\n",
  );
});

test("the first section goes under the introduction", () => {
  expect(insert("# Changelog\n\nIntro.\n", "0.0.1-rc.1", "## 0.0.1-rc.1 - d\n\n- A\n")).toBe(
    "# Changelog\n\nIntro.\n\n## 0.0.1-rc.1 - d\n\n- A\n",
  );
});

test("the worker's version is the product version in PEP 440 spelling", () => {
  expect(pythonVersion("0.1.0")).toBe("0.1.0");
  expect(pythonVersion("0.1.0-rc.1")).toBe("0.1.0rc1");
  expect(pythonVersion("1.2.3-beta.4")).toBe("1.2.3b4");
  expect(() => pythonVersion("0.1.0-nightly.1")).toThrow("PEP 440");
  const pyproject = '[project]\nname = "w"\nversion = "0.0.2"\n\n[tool.x]\nversion = "9"\n';
  expect(setPythonVersion(pyproject, "0.1.0-rc.2")).toBe(
    '[project]\nname = "w"\nversion = "0.1.0rc2"\n\n[tool.x]\nversion = "9"\n',
  );
  expect(() => setPythonVersion("[project]\n", "0.1.0")).toThrow("no version line");
});
