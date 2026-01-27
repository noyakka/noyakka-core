import prisma from "./prisma";
import { createServiceM8Client } from "../servicem8";

const BASE_URL = "https://api.servicem8.com";

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  company_uuid?: string;
};

const tokenEndpoint = `${BASE_URL}/oauth/access_token`;

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

export const getServiceM8AccessToken = async (companyUuid: string) => {
  const connection = await prisma.serviceM8Connection.findUnique({
    where: { company_uuid: companyUuid },
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
    const refreshed = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: connection.refresh_token,
      client_id: process.env.SERVICEM8_APP_ID || "",
      client_secret: process.env.SERVICEM8_APP_SECRET || "",
    });

    accessToken = refreshed.access_token;
    const nextExpiresAt = refreshed.expires_in
      ? new Date(Date.now() + refreshed.expires_in * 1000)
      : null;

    await prisma.serviceM8Connection.update({
      where: { company_uuid: companyUuid },
      data: {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token ?? connection.refresh_token,
        expires_at: nextExpiresAt,
      },
    });
  }

  return accessToken;
};

export const getServiceM8Client = async (companyUuid: string) => {
  const accessToken = await getServiceM8AccessToken(companyUuid);
  return createServiceM8Client({
    baseUrl: `${BASE_URL}/api_1.0`,
    accessToken,
  });
};
