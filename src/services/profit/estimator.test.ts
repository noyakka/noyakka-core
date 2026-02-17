import { describe, expect, it } from "vitest";
import { DEFAULT_FINANCIAL_CONFIG, estimateProfit } from "./estimator";

describe("estimateProfit", () => {
  it("returns healthy margins for switchboard upgrades", () => {
    const result = estimateProfit("SWITCHBOARD_UPGRADE", DEFAULT_FINANCIAL_CONFIG);
    expect(result.marginStatus).toBe("HEALTHY");
    expect(result.marginPct).toBeGreaterThan(DEFAULT_FINANCIAL_CONFIG.healthyMarginThreshold);
  });

  it("returns low margin for lighting simple with aggressive cost config", () => {
    const result = estimateProfit("LIGHTING_SIMPLE", {
      ...DEFAULT_FINANCIAL_CONFIG,
      internalCostRate: 300,
      overheadPerJob: 180,
    });
    expect(result.marginStatus).toBe("LOW_MARGIN");
  });

  it("uses unknown defaults safely", () => {
    const result = estimateProfit("UNKNOWN", DEFAULT_FINANCIAL_CONFIG);
    expect(result.estimate.durationMinutes.min).toBe(60);
    expect(result.estimate.revenue.max).toBe(500);
  });
});
