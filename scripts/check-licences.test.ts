import { expect, test } from "bun:test";
import { allowed } from "./check-licences.ts";

test("single allowed licences pass", () => {
  expect(allowed("MIT")).toBe(true);
  expect(allowed("Apache-2.0")).toBe(true);
});

test("an OR expression passes when one branch is allowed", () => {
  expect(allowed("(MIT OR GPL-3.0-only)")).toBe(true);
  expect(allowed("GPL-2.0-only OR LGPL-3.0-only")).toBe(false);
});

test("an AND expression needs every licence allowed", () => {
  expect(allowed("Apache-2.0 AND MIT")).toBe(true);
  expect(allowed("MIT AND GPL-3.0-only")).toBe(false);
});

test("copyleft, unlicensed and missing licences fail", () => {
  expect(allowed("GPL-3.0-only")).toBe(false);
  expect(allowed("UNLICENSED")).toBe(false);
  expect(allowed("SEE LICENSE IN LICENSE.md")).toBe(false);
  expect(allowed("")).toBe(false);
});
