import prisma from "./prisma";
import { createServiceM8Client } from "../servicem8";

const API_BASE_URL = "https://api.servicem8.com";
const OAUTH_BASE_URL = "https://go.servicem8.com";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  company_uuid?: string;
};

const tokenEndpoint = `${OAUTH_BASE_URL}/oauth/access_token`;
const refreshLocks = new Map<string, Promise<string>>();

let cachedApiKeyVendorUuid: string | null = null;

/** Resolve vendor UUID for API key mode. Fetches from vendor.json if not in env. */
export async function resolveVendorUuidForApiKey(): Promise<string | null> {
  const envVendor = process.env.SERVICEM8_VENDOR_UUID;
  if (envVendor) return envVendor;
  if (cachedApiKeyVendorUuid) return cachedApiKeyVendorUuid;

  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch(`${API_BASE_URL}/api_1.0/vendor.json`, {
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
    });
    const data = (await res.json()) as unknown;
    const first = Array.isArray(data) ? data[0] : data;
    const obj = first && typeof first === "object" ? (first as Record<string, unknown>) : null;
    const uuid = (obj?.uuid ?? obj?.vendor_uuid) as string | undefined;
    if (typeof uuid === "string") {
      cachedApiKeyVendorUuid = uuid;
      return uuid;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const exchangeToken = async (payload: Record<string, string>) => {
  const body = new URLSearchParams(payload);
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = (await res.json()) as TokenResponse;
  if (!res.ok || !data.access_token) {
    const err: any = new Error("ServiceM8 token exchange failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

export const getServiceM8AccessToken = async (vendorUuid: string) => {
  const connection = await prisma.serviceM8Connection.findUnique({
    where: { vendor_uuid: vendorUuid },
  });

  if (!connection) {
    const err: any = new Error("ServiceM8 connection not found");
    err.status = 404;
    throw err;
  }

  let accessToken = connection.access_token;
  const expiresAt = connection.expires_at?.getTime() ?? null;
  const now = Date.now();

  if (expiresAt && expiresAt - now < 60_000 && connection.refresh_token) {
    const existingLock = refreshLocks.get(vendorUuid);
    if (existingLock) {
      return existingLock;
    }

    const refreshPromise = (async () => {
      try {
        const refreshed = await exchangeToken({
          grant_type: "refresh_token",
          refresh_token: connection.refresh_token!,
          client_id: process.env.SERVICEM8_APP_ID || "",
          client_secret: process.env.SERVICEM8_APP_SECRET || "",
        });

        accessToken = refreshed.access_token;
        const nextExpiresAt = refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000)
          : null;

        await prisma.serviceM8Connection.update({
          where: { vendor_uuid: vendorUuid },
          data: {
            access_token: refreshed.access_token,
            refresh_token: refreshed.refresh_token ?? connection.refresh_token,
            expires_at: nextExpiresAt,
          },
        });

        return accessToken;
      } catch (err: any) {
        const errorCode = err?.data?.error;
        const errorDescription = String(err?.data?.error_description || "");
        if (errorCode === "invalid_grant" && errorDescription.includes("Refresh token previously used")) {
          const latest = await prisma.serviceM8Connection.findUnique({
            where: { vendor_uuid: vendorUuid },
          });
          const latestExpiresAt = latest?.expires_at?.getTime() ?? null;
          if (latest?.access_token && (!latestExpiresAt || latestExpiresAt - Date.now() > 60_000)) {
            return latest.access_token;
          }
        }
        throw err;
      }
    })();

    refreshLocks.set(vendorUuid, refreshPromise);
    try {
      return await refreshPromise;
    } finally {
      refreshLocks.delete(vendorUuid);
    }
  }

  return accessToken;
};

/** Returns auth for API calls: Bearer token or X-API-Key. Used by SMS and other direct fetch calls. */
export const getServiceM8Auth = async (vendorUuid: string): Promise<{ bearer?: string; apiKey?: string }> => {
  const apiKey = process.env.SERVICEM8_API_KEY;
  const envVendor = process.env.SERVICEM8_VENDOR_UUID;
  if (apiKey && (vendorUuid === envVendor || !envVendor)) {
    return { apiKey };
  }
  const token = await getServiceM8AccessToken(vendorUuid);
  return { bearer: token };
};

export const getServiceM8Client = async (vendorUuid: string) => {
  const apiKey = process.env.SERVICEM8_API_KEY;
  const envVendor = process.env.SERVICEM8_VENDOR_UUID;

  // API key mode: use when API key is set (single-tenant), or when vendor matches env
  if (apiKey && (!envVendor || vendorUuid === envVendor || !vendorUuid)) {
    return createServiceM8Client({
      baseUrl: `${API_BASE_URL}/api_1.0`,
      apiKey,
    });
  }

  const accessToken = await getServiceM8AccessToken(vendorUuid);
  return createServiceM8Client({
    baseUrl: `${API_BASE_URL}/api_1.0`,
    accessToken,
  });
};
