import { describe, expect, it } from "vitest";
import { classifyElectricalJob } from "./classifier";

describe("classifyElectricalJob", () => {
  it("classifies emergency by emergency keywords", () => {
    const result = classifyElectricalJob("No power in kitchen and burning smell from switchboard");
    expect(result.jobTypeKey).toBe("EMERGENCY");
    expect(result.matchedKeywords.length).toBeGreaterThan(0);
  });

  it("classifies powerpoint installs", () => {
    const result = classifyElectricalJob("Need a new power point near TV outlet");
    expect(result.jobTypeKey).toBe("POWERPOINT_INSTALL");
  });

  it("falls back to UNKNOWN for unmatched text", () => {
    const result = classifyElectricalJob("Please call me back");
    expect(result.jobTypeKey).toBe("UNKNOWN");
  });
});
