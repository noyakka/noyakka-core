import { describe, expect, it } from "vitest";
import { detectRiskFlags } from "./risk";

describe("detectRiskFlags", () => {
  it("detects small job keywords", () => {
    const result = detectRiskFlags({
      jobDescription: "Need to replace one light bulb in hallway",
      smallJobKeywords: ["bulb", "switch"],
    });
    expect(result.smallJob).toBe(true);
    expect(result.flags).toContain("SMALL_JOB_RISK");
    expect(result.matchedKeywords).toContain("bulb");
  });

  it("detects price shopper language", () => {
    const result = detectRiskFlags({
      jobDescription: "How much? looking for cheap quote only",
      smallJobKeywords: ["bulb"],
    });
    expect(result.flags).toContain("PRICE_SHOPPER_RISK");
  });
});
