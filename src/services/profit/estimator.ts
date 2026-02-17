import type { ElectricalJobTypeKey } from "./classifier";

export type BusinessFinancialConfig = {
  minimumCallout: number;
  includedMinutes: number;
  hourlyRate: number;
  internalCostRate: number;
  overheadPerJob: number;
  regretMarginThreshold: number;
  healthyMarginThreshold: number;
};

export type JobEstimate = {
  durationMinutes: { min: number; max: number };
  revenue: { min: number; max: number };
};

export type MarginStatus = "HEALTHY" | "MARGINAL" | "LOW_MARGIN";

export type ProfitEstimate = {
  estimate: JobEstimate;
  revenueMid: number;
  durationHoursMid: number;
  estimatedProfit: number;
  marginPct: number;
  marginStatus: MarginStatus;
};

export const DEFAULT_FINANCIAL_CONFIG: BusinessFinancialConfig = {
  minimumCallout: 180,
  includedMinutes: 30,
  hourlyRate: 100,
  internalCostRate: 55,
  overheadPerJob: 30,
  regretMarginThreshold: 15,
  healthyMarginThreshold: 20,
};

export const JOB_ESTIMATES: Record<ElectricalJobTypeKey, JobEstimate> = {
  LIGHTING_SIMPLE: { durationMinutes: { min: 30, max: 45 }, revenue: { min: 180, max: 250 } },
  POWERPOINT_INSTALL: { durationMinutes: { min: 45, max: 90 }, revenue: { min: 180, max: 300 } },
  SWITCH_REPLACEMENT: { durationMinutes: { min: 30, max: 60 }, revenue: { min: 180, max: 250 } },
  SMOKE_ALARM: { durationMinutes: { min: 30, max: 60 }, revenue: { min: 180, max: 300 } },
  SAFETY_SWITCH_RCD: { durationMinutes: { min: 60, max: 120 }, revenue: { min: 250, max: 450 } },
  SWITCHBOARD_UPGRADE: { durationMinutes: { min: 180, max: 300 }, revenue: { min: 800, max: 1800 } },
  FAULT_FINDING: { durationMinutes: { min: 60, max: 180 }, revenue: { min: 250, max: 700 } },
  CEILING_FAN: { durationMinutes: { min: 90, max: 180 }, revenue: { min: 300, max: 600 } },
  DATA_TV: { durationMinutes: { min: 60, max: 120 }, revenue: { min: 250, max: 500 } },
  EMERGENCY: { durationMinutes: { min: 60, max: 180 }, revenue: { min: 300, max: 900 } },
  UNKNOWN: { durationMinutes: { min: 60, max: 120 }, revenue: { min: 200, max: 500 } },
};

const midpoint = (min: number, max: number) => (min + max) / 2;

export const estimateProfit = (
  jobTypeKey: ElectricalJobTypeKey,
  config: BusinessFinancialConfig = DEFAULT_FINANCIAL_CONFIG
): ProfitEstimate => {
  const estimate = JOB_ESTIMATES[jobTypeKey] ?? JOB_ESTIMATES.UNKNOWN;
  const durationMidMinutes = midpoint(estimate.durationMinutes.min, estimate.durationMinutes.max);
  const durationHoursMid = durationMidMinutes / 60;
  const revenueMid = midpoint(estimate.revenue.min, estimate.revenue.max);
  const laborCost = durationHoursMid * config.internalCostRate;
  const estimatedProfit = revenueMid - (laborCost + config.overheadPerJob);
  const marginPct = revenueMid > 0 ? (estimatedProfit / revenueMid) * 100 : 0;

  let marginStatus: MarginStatus = "LOW_MARGIN";
  if (marginPct >= config.healthyMarginThreshold) {
    marginStatus = "HEALTHY";
  } else if (marginPct >= config.regretMarginThreshold) {
    marginStatus = "MARGINAL";
  }

  return {
    estimate,
    revenueMid,
    durationHoursMid,
    estimatedProfit,
    marginPct,
    marginStatus,
  };
};
