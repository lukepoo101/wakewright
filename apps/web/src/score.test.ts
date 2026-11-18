import { describe, expect, test } from "bun:test";
import { scoreBar, scoreNumbers, scoreSummary } from "./score.ts";

describe("a probability (microWakeWord, 0–1)", () => {
  test("is formatted with two decimals", () => {
    expect(scoreNumbers(0.82, 0.6)).toEqual({ score: "0.82", threshold: "0.60" });
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

  test("the summary reads against the threshold", () => {
    expect(scoreSummary(8.4, 10.5)).toBe("Reached 80% of the threshold.");
    expect(scoreSummary(15.6, 10.5)).toBe("Over the threshold: the wake word fired.");
    expect(scoreSummary(24.2, 10.5)).toBe("2.3 times the threshold: the wake word fired.");
    expect(scoreSummary(20.9, 10.5)).toBe("Over the threshold: the wake word fired.");
    expect(scoreSummary(15.6, null)).toBe("");
  });
});

describe("the score bar", () => {
  test("always reads the score against the clip's own threshold", () => {
    // Half way is the threshold, whatever the engine's scale.
    expect(scoreBar(0.6, 0.6)).toEqual({ fill: 0.5 });
    expect(scoreBar(10.5, 10.5)).toEqual({ fill: 0.5 });
    // 90% of the threshold fills 45% of the bar on either scale.
    expect(scoreBar(0.81, 0.9)?.fill).toBeCloseTo(0.45);
    expect(scoreBar(11.25, 12.5)?.fill).toBeCloseTo(0.45);
    expect(scoreBar(8.4, 10.5)).toEqual({ fill: 0.4 });
  });

  test("twice the threshold or more fills it, and nothing is negative", () => {
    expect(scoreBar(24.2, 10.5)).toEqual({ fill: 1 });
    expect(scoreBar(1, 0.4)).toEqual({ fill: 1 });
    expect(scoreBar(-3, 10.5)).toEqual({ fill: 0 });
  });

  test("without a threshold there is no bar", () => {
    expect(scoreBar(0.3, null)).toBeNull();
    expect(scoreBar(15.6, null)).toBeNull();
    expect(scoreBar(15.6, 0)).toBeNull();
  });
});
