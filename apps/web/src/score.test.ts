import { describe, expect, test } from "bun:test";
import { scoreBar, scoreNumbers, scoreSummary } from "./score.ts";

describe("a probability (microWakeWord, 0–1)", () => {
  test("is drawn on 0–1 with two decimals", () => {
    expect(scoreNumbers(0.82, 0.6)).toEqual({ score: "0.82", threshold: "0.60" });
    expect(scoreBar(0.82, 0.6)).toEqual({ fill: 0.82, marker: 0.6 });
    expect(scoreBar(0.3, null)).toEqual({ fill: 0.3, marker: null });
  });

  test("a near miss reports how close it came, rounded down", () => {
    expect(scoreSummary(0.45, 0.6)).toBe("Reached 75% of the threshold.");
    expect(scoreSummary(0.5999, 0.6)).toBe("Reached 99% of the threshold.");
    expect(scoreSummary(0.97, 0.6)).toBe("Over the threshold: the wake word fired.");
  });
});

describe("a vsWakeWord score (threshold around 10)", () => {
  test("is formatted with one decimal and the same decimals for both numbers", () => {
    expect(scoreNumbers(15.6, 10.5)).toEqual({ score: "15.6", threshold: "10.5" });
    expect(scoreNumbers(8.25, 10.5)).toEqual({ score: "8.3", threshold: "10.5" });
    expect(scoreNumbers(15.6)).toEqual({ score: "15.6", threshold: null });
    expect(scoreNumbers(1234.5, 1000)).toEqual({ score: "1,235", threshold: "1,000" });
  });

  test("is drawn against the threshold, not clamped to 0–1", () => {
    expect(scoreBar(15.6, 10.5)).toEqual({ fill: 15.6 / 21, marker: 0.5 });
    expect(scoreBar(8.4, 10.5)).toEqual({ fill: 0.4, marker: 0.5 });
    // More than double the threshold fills the bar.
    expect(scoreBar(24.2, 10.5)).toEqual({ fill: 1, marker: 0.5 });
    // No threshold: no scale to draw on.
    expect(scoreBar(15.6, null)).toBeNull();
  });

  test("the summary reads against the threshold", () => {
    expect(scoreSummary(8.4, 10.5)).toBe("Reached 80% of the threshold.");
    expect(scoreSummary(15.6, 10.5)).toBe("Over the threshold: the wake word fired.");
    expect(scoreSummary(24.2, 10.5)).toBe("2.3 times the threshold: the wake word fired.");
    expect(scoreSummary(20.9, 10.5)).toBe("Over the threshold: the wake word fired.");
    expect(scoreSummary(15.6, null)).toBe("");
  });
});
