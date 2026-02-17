type LatLng = { lat: number; lng: number };

export type DistanceBand = "LOCAL" | "MEDIUM" | "FAR";

export type DistanceResult = {
  distanceKm: number;
  band: DistanceBand;
  provider: "google";
  raw: unknown;
};

const geocodeCache = new Map<string, { latLng: LatLng; expiresAt: number }>();
const distanceCache = new Map<string, { distanceKm: number; raw: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60;

const getCache = <T>(cache: Map<string, { expiresAt: number } & T>, key: string): T | null => {
  const existing = cache.get(key);
  if (!existing) {
    return null;
  }
  if (existing.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  const { expiresAt: _expiresAt, ...rest } = existing;
  return rest as T;
};

const setCache = <T>(cache: Map<string, { expiresAt: number } & T>, key: string, value: T) => {
  cache.set(key, { ...value, expiresAt: Date.now() + CACHE_TTL_MS });
};

export const classifyDistanceBand = (
  distanceKm: number,
  thresholds: { mediumKm: number; farKm: number }
): DistanceBand => {
  if (distanceKm >= thresholds.farKm) {
    return "FAR";
  }
  if (distanceKm >= thresholds.mediumKm) {
    return "MEDIUM";
  }
  return "LOCAL";
};

export const geocodeAddress = async (input: {
  address: string;
  provider: "google";
  apiKey: string;
}): Promise<{ lat: number; lng: number; raw: unknown }> => {
  const key = `${input.provider}:${input.address.trim().toLowerCase()}`;
  const cached = getCache<{ latLng: LatLng }>(geocodeCache, key);
  if (cached) {
    return { ...cached.latLng, raw: { cache: true } };
  }

  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", input.address);
  url.searchParams.set("key", input.apiKey);

  const response = await fetch(url.toString(), { method: "GET" });
  const json = (await response.json()) as any;
  if (!response.ok || json?.status !== "OK" || !Array.isArray(json?.results) || !json.results[0]?.geometry?.location) {
    throw new Error(`Geocode failed (${json?.status || response.status})`);
  }
  const lat = Number(json.results[0].geometry.location.lat);
  const lng = Number(json.results[0].geometry.location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("Geocode returned invalid coordinates");
  }
  setCache(geocodeCache, key, { latLng: { lat, lng } });
  return { lat, lng, raw: json };
};

export const getDistanceKm = async (input: {
  origin: string;
  destination: string;
  provider: "google";
  apiKey: string;
}): Promise<{ distanceKm: number; raw: unknown }> => {
  const cacheKey = `${input.provider}:${input.origin.trim().toLowerCase()}=>${input.destination.trim().toLowerCase()}`;
  const cached = getCache<{ distanceKm: number; raw: unknown }>(distanceCache, cacheKey);
  if (cached) {
    return cached;
  }

  const matrixUrl = new URL("https://maps.googleapis.com/maps/api/distancematrix/json");
  matrixUrl.searchParams.set("origins", input.origin);
  matrixUrl.searchParams.set("destinations", input.destination);
  matrixUrl.searchParams.set("key", input.apiKey);

  const matrixRes = await fetch(matrixUrl.toString(), { method: "GET" });
  const matrixJson = (await matrixRes.json()) as any;
  const element = matrixJson?.rows?.[0]?.elements?.[0];
  if (
    matrixRes.ok &&
    matrixJson?.status === "OK" &&
    element?.status === "OK" &&
    typeof element?.distance?.value === "number"
  ) {
    const distanceKm = Number(element.distance.value) / 1000;
    const result = { distanceKm, raw: matrixJson };
    setCache(distanceCache, cacheKey, result);
    return result;
  }

  const directionsUrl = new URL("https://maps.googleapis.com/maps/api/directions/json");
  directionsUrl.searchParams.set("origin", input.origin);
  directionsUrl.searchParams.set("destination", input.destination);
  directionsUrl.searchParams.set("key", input.apiKey);
  const directionsRes = await fetch(directionsUrl.toString(), { method: "GET" });
  const directionsJson = (await directionsRes.json()) as any;
  const leg = directionsJson?.routes?.[0]?.legs?.[0];
  if (
    directionsRes.ok &&
    directionsJson?.status === "OK" &&
    typeof leg?.distance?.value === "number"
  ) {
    const distanceKm = Number(leg.distance.value) / 1000;
    const result = { distanceKm, raw: directionsJson };
    setCache(distanceCache, cacheKey, result);
    return result;
  }

  throw new Error(
    `Distance lookup failed (matrix=${matrixJson?.status || matrixRes.status}, directions=${directionsJson?.status || directionsRes.status})`
  );
};

export const measureDistance = async (input: {
  originAddress: string;
  destinationAddress: string;
  provider: "google";
  apiKey: string;
  thresholds: { mediumKm: number; farKm: number };
}): Promise<DistanceResult> => {
  const { distanceKm, raw } = await getDistanceKm({
    origin: input.originAddress,
    destination: input.destinationAddress,
    provider: input.provider,
    apiKey: input.apiKey,
  });
  return {
    distanceKm,
    band: classifyDistanceBand(distanceKm, input.thresholds),
    provider: input.provider,
    raw,
  };
};
