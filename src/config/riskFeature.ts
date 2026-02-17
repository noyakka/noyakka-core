const toBool = (value: string | undefined, fallback: boolean) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const toNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const splitKeywords = (value: string | undefined, fallback: string[]) => {
  if (!value) {
    return fallback;
  }
  const values = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : fallback;
};

export type RiskFeatureConfig = {
  mapsProvider: "google";
  googleMapsApiKey?: string;
  businessBaseAddress?: string;
  distanceEnabled: boolean;
  smsEnabled: boolean;
  riskEnrichDryRun: boolean;
  distanceFarKm: number;
  distanceMediumKm: number;
  smallJobKeywords: string[];
};

let cachedConfig: RiskFeatureConfig | null = null;

export const getRiskFeatureConfig = (): RiskFeatureConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    mapsProvider: "google",
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || undefined,
    businessBaseAddress: process.env.BUSINESS_BASE_ADDRESS || undefined,
    distanceEnabled: toBool(process.env.DISTANCE_ENABLED, false),
    smsEnabled: toBool(process.env.SMS_ENABLED, false),
    riskEnrichDryRun: toBool(process.env.RISK_ENRICH_DRY_RUN, false),
    distanceFarKm: toNumber(process.env.DISTANCE_FAR_KM, 25),
    distanceMediumKm: toNumber(process.env.DISTANCE_MEDIUM_KM, 10),
    smallJobKeywords: splitKeywords(process.env.SMALL_JOB_KEYWORDS, [
      "bulb",
      "light",
      "globe",
      "powerpoint",
      "switch",
      "replace",
      "swap",
      "quick",
      "small job",
    ]),
  };

  return cachedConfig;
};

export const validateRiskFeatureConfig = () => {
  const config = getRiskFeatureConfig();
  const issues: string[] = [];
  if (config.distanceEnabled && !config.businessBaseAddress) {
    issues.push("BUSINESS_BASE_ADDRESS is required when DISTANCE_ENABLED=true");
  }
  if (config.distanceEnabled && !config.googleMapsApiKey) {
    issues.push("GOOGLE_MAPS_API_KEY is required when DISTANCE_ENABLED=true");
  }
  if (config.distanceMediumKm >= config.distanceFarKm) {
    issues.push("DISTANCE_MEDIUM_KM must be lower than DISTANCE_FAR_KM");
  }
  return { config, issues };
};
