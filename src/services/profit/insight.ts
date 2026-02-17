import { sendServiceM8Sms } from "../../lib/servicem8-sms";
import { logOpsEvent } from "../../lib/opsEvents";
import type { JobClassification } from "./classifier";
import { classifyElectricalJob } from "./classifier";
import {
  DEFAULT_FINANCIAL_CONFIG,
  estimateProfit,
  type BusinessFinancialConfig,
  type MarginStatus,
} from "./estimator";

const marginLabel = (status: MarginStatus) => {
  if (status === "HEALTHY") {
    return "✅ Healthy";
  }
  if (status === "MARGINAL") {
    return "⚠️ Marginal";
  }
  return "🔴 Low Margin";
};

export const parseFinancialEnv = (): BusinessFinancialConfig => {
  const getNum = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    minimumCallout: getNum(process.env.FIN_MINIMUM_CALLOUT, DEFAULT_FINANCIAL_CONFIG.minimumCallout),
    includedMinutes: getNum(process.env.FIN_INCLUDED_MINUTES, DEFAULT_FINANCIAL_CONFIG.includedMinutes),
    hourlyRate: getNum(process.env.FIN_HOURLY_RATE, DEFAULT_FINANCIAL_CONFIG.hourlyRate),
    internalCostRate: getNum(process.env.FIN_INTERNAL_COST_RATE, DEFAULT_FINANCIAL_CONFIG.internalCostRate),
    overheadPerJob: getNum(process.env.FIN_OVERHEAD_PER_JOB, DEFAULT_FINANCIAL_CONFIG.overheadPerJob),
    regretMarginThreshold: getNum(
      process.env.FIN_REGRET_MARGIN_THRESHOLD,
      DEFAULT_FINANCIAL_CONFIG.regretMarginThreshold
    ),
    healthyMarginThreshold: getNum(
      process.env.FIN_HEALTHY_MARGIN_THRESHOLD,
      DEFAULT_FINANCIAL_CONFIG.healthyMarginThreshold
    ),
  };
};

export const buildProfitInsightNote = (input: {
  classification: JobClassification;
  estimate: ReturnType<typeof estimateProfit>;
}) => {
  return [
    "🤖 NOYAKKA PROFIT INSIGHT",
    "",
    `jobType: ${input.classification.jobTypeKey}`,
    `estDurationMins: ${input.estimate.estimate.durationMinutes.min}-${input.estimate.estimate.durationMinutes.max}`,
    `estValue: $${input.estimate.estimate.revenue.min}-$${input.estimate.estimate.revenue.max}`,
    `marginFlag: ${input.estimate.marginStatus}`,
    "",
    `Type: ${input.classification.jobTypeKey} (Confidence: ${input.classification.confidence}%)`,
    `Est Revenue: $${input.estimate.estimate.revenue.min} - $${input.estimate.estimate.revenue.max}`,
    `Est Duration: ${input.estimate.estimate.durationMinutes.min} - ${input.estimate.estimate.durationMinutes.max} mins`,
    `Est Margin: ~${input.estimate.marginPct.toFixed(1)}%`,
    "",
    `Status: ${marginLabel(input.estimate.marginStatus)}`,
    "",
    "Reminder:",
    "These are AI estimates only.",
    "Final pricing & travel impact must be reviewed by dispatcher.",
  ].join("\n");
};

const extractSuburb = (address: string) => {
  const parts = String(address || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "Unknown";
};

export const runProfitInsightForJob = async (input: {
  sm8: { postJson: (path: string, body: unknown) => Promise<unknown> };
  vendor_uuid: string;
  job_uuid: string;
  job_number: string;
  job_description: string;
  job_address: string;
  staff_uuid?: string;
  dispatcher_mobile?: string;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
  };
}) => {
  const classification = classifyElectricalJob(input.job_description);
  const config = parseFinancialEnv();
  const estimate = estimateProfit(classification.jobTypeKey, config);
  const note = buildProfitInsightNote({ classification, estimate });

  await input.sm8.postJson("/jobactivity.json", {
    job_uuid: input.job_uuid,
    ...(input.staff_uuid ? { staff_uuid: input.staff_uuid } : {}),
    type: "note",
    note,
  });

  if (estimate.marginStatus === "LOW_MARGIN" && input.dispatcher_mobile) {
    const lowMarginAlert = `⚠️ Low margin flag:\nJob #${input.job_number}\nType: ${classification.jobTypeKey}\nEst Margin: ${estimate.marginPct.toFixed(1)}%\nSuburb: ${extractSuburb(input.job_address)}\nReview before dispatch.`;
    try {
      await sendServiceM8Sms({
        companyUuid: input.vendor_uuid,
        toMobile: input.dispatcher_mobile,
        message: lowMarginAlert,
        regardingJobUuid: input.job_uuid,
      });
    } catch (err: any) {
      input.logger.warn(
        {
          job_uuid: input.job_uuid,
          error: err?.message,
          status: err?.status,
        },
        "Low margin dispatcher alert failed"
      );
    }
  }

  input.logger.info(
    {
      job_uuid: input.job_uuid,
      job_type: classification.jobTypeKey,
      confidence: classification.confidence,
      matched_keywords: classification.matchedKeywords,
      margin_pct: estimate.marginPct,
      margin_status: estimate.marginStatus,
    },
    "Profit insight attached"
  );

  logOpsEvent(input.logger, "PROFIT_FLAGGED", {
    job_uuid: input.job_uuid,
    job_number: input.job_number,
    margin_status: estimate.marginStatus,
    margin_pct: Number(estimate.marginPct.toFixed(1)),
    job_type: classification.jobTypeKey,
  });
};
