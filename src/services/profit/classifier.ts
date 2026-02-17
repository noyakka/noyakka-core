export type ElectricalJobTypeKey =
  | "LIGHTING_SIMPLE"
  | "POWERPOINT_INSTALL"
  | "SWITCH_REPLACEMENT"
  | "SMOKE_ALARM"
  | "SAFETY_SWITCH_RCD"
  | "SWITCHBOARD_UPGRADE"
  | "FAULT_FINDING"
  | "CEILING_FAN"
  | "DATA_TV"
  | "EMERGENCY"
  | "UNKNOWN";

export type JobClassification = {
  jobTypeKey: ElectricalJobTypeKey;
  confidence: number;
  matchedKeywords: string[];
};

const KEYWORDS: Array<{ type: ElectricalJobTypeKey; terms: string[] }> = [
  {
    type: "EMERGENCY",
    terms: [
      "sparks",
      "burning smell",
      "smoke",
      "urgent",
      "no power",
      "water near",
      "after hours",
      "tripping constantly",
    ],
  },
  { type: "POWERPOINT_INSTALL", terms: ["power point", "gpo", "socket", "outlet"] },
  {
    type: "SWITCHBOARD_UPGRADE",
    terms: ["switchboard", "fuse box", "upgrade board", "old ceramic fuses"],
  },
  { type: "FAULT_FINDING", terms: ["fault", "keeps tripping", "intermittent", "not working"] },
  { type: "LIGHTING_SIMPLE", terms: ["light", "lighting", "bulb", "globe", "downlight"] },
  { type: "SWITCH_REPLACEMENT", terms: ["switch replacement", "replace switch", "light switch"] },
  { type: "SMOKE_ALARM", terms: ["smoke alarm", "smoke detector"] },
  { type: "SAFETY_SWITCH_RCD", terms: ["safety switch", "rcd"] },
  { type: "CEILING_FAN", terms: ["ceiling fan", "fan install"] },
  { type: "DATA_TV", terms: ["data point", "tv point", "antenna", "ethernet"] },
];

export const classifyElectricalJob = (description: string): JobClassification => {
  const text = String(description || "").toLowerCase();
  if (!text.trim()) {
    return { jobTypeKey: "UNKNOWN", confidence: 0, matchedKeywords: [] };
  }

  let bestType: ElectricalJobTypeKey = "UNKNOWN";
  let bestMatches: string[] = [];

  for (const entry of KEYWORDS) {
    const matches = entry.terms.filter((term) => text.includes(term));
    if (matches.length > bestMatches.length) {
      bestType = entry.type;
      bestMatches = matches;
    }
  }

  if (bestType === "UNKNOWN") {
    return { jobTypeKey: "UNKNOWN", confidence: 25, matchedKeywords: [] };
  }

  const confidence = Math.min(95, 55 + bestMatches.length * 15);
  return {
    jobTypeKey: bestType,
    confidence,
    matchedKeywords: bestMatches,
  };
};
