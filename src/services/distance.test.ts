import { describe, expect, it } from "vitest";
import { classifyDistanceBand } from "./distance";

describe("classifyDistanceBand", () => {
  const thresholds = { mediumKm: 10, farKm: 25 };

  it("returns LOCAL below medium threshold", () => {
    expect(classifyDistanceBand(9.9, thresholds)).toBe("LOCAL");
  });

  it("returns MEDIUM between medium and far thresholds", () => {
    expect(classifyDistanceBand(10, thresholds)).toBe("MEDIUM");
    expect(classifyDistanceBand(24.9, thresholds)).toBe("MEDIUM");
  });

  it("returns FAR at or above far threshold", () => {
    expect(classifyDistanceBand(25, thresholds)).toBe("FAR");
  });
});
