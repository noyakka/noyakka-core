export type RiskResult = {
  flags: string[];
  smallJob: boolean;
  matchedKeywords: string[];
};

const PRICE_SHOPPER_KEYWORDS = [
  "how much",
  "cheap",
  "quote only",
  "best price",
  "lowest price",
  "price match",
  "budget",
];

export const detectRiskFlags = (input: {
  jobDescription?: string;
  jobType?: string;
  smallJobKeywords: string[];
}): RiskResult => {
  const text = `${input.jobDescription ?? ""} ${input.jobType ?? ""}`.toLowerCase();
  const matchedSmallJob = input.smallJobKeywords.filter((keyword) => text.includes(keyword.toLowerCase()));
  const hasPriceShopper = PRICE_SHOPPER_KEYWORDS.some((keyword) => text.includes(keyword));

  const flags: string[] = [];
  if (matchedSmallJob.length > 0) {
    flags.push("SMALL_JOB_RISK");
  }
  if (hasPriceShopper) {
    flags.push("PRICE_SHOPPER_RISK");
  }

  return {
    flags,
    smallJob: matchedSmallJob.length > 0,
    matchedKeywords: matchedSmallJob,
  };
};
