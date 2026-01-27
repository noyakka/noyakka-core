import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "crypto";
import prisma from "../lib/prisma";

const OAUTH_BASE_URL = "https://go.servicem8.com";
const OAUTH_TTL_MS = 10 * 60 * 1000;

type StartQuery = {
  vendor_uuid?: string;
  state?: string;
};

type CallbackQuery = {
  code?: string;
  state?: string;
};

const tokenEndpoint = `${OAUTH_BASE_URL}/oauth/access_token`;

export const registerServiceM8AuthRoutes = (fastify: FastifyInstance) => {
  fastify.get(
    "/auth/servicem8/start",
    async (request: FastifyRequest<{ Querystring: StartQuery }>, reply: FastifyReply) => {
      const { vendor_uuid } = request.query;
      const state = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + OAUTH_TTL_MS);

      await prisma.oAuthState.create({
        data: {
          state,
          vendor_uuid,
          expires_at: expiresAt,
        },
      });

      const redirectBase = fastify.config.BASE_URL || "https://noyakka-core.fly.dev";
      const redirectUri = `${redirectBase}/auth/servicem8/callback`;
      const scope = [
        "vendor",
        "create_jobs",
        "manage_customers",
        "manage_job_contacts",
        "publish_sms",
      ].join(" ");
      const params = new URLSearchParams({
        response_type: "code",
        client_id: fastify.config.SERVICEM8_APP_ID,
        redirect_uri: redirectUri,
        state,
        scope,
      });

      const authorizeUrl = `${OAUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
      return reply.redirect(authorizeUrl);
    }
  );

  fastify.get(
    "/auth/servicem8/callback",
    async (request: FastifyRequest<{ Querystring: CallbackQuery }>, reply: FastifyReply) => {
      const { code, state } = request.query;
      if (!code || !state) {
        return reply.status(400).send("Missing code or state");
      }

      const record = await prisma.oAuthState.findUnique({ where: { state } });
      if (!record || record.expires_at.getTime() < Date.now()) {
        return reply.status(400).send("Invalid or expired state");
      }

      await prisma.oAuthState.delete({ where: { state } });

      const redirectBase = fastify.config.BASE_URL || "https://noyakka-core.fly.dev";
      const redirectUri = `${redirectBase}/auth/servicem8/callback`;
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: fastify.config.SERVICEM8_APP_ID,
        client_secret: fastify.config.SERVICEM8_APP_SECRET,
        code,
        redirect_uri: redirectUri,
      });

      const tokenRes = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        return reply.status(500).send("ServiceM8 token exchange failed");
      }

      const vendorRes = await fetch("https://api.servicem8.com/api_1.0/vendor.json", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: "application/json",
        },
      });
      const vendorData = await vendorRes.json();
      const vendorUuid = Array.isArray(vendorData) ? vendorData[0]?.uuid : vendorData?.uuid;
      if (!vendorUuid) {
        return reply.status(500).send("Missing vendor uuid from ServiceM8");
      }

      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000)
        : null;

      await prisma.serviceM8Connection.upsert({
        where: { vendor_uuid: vendorUuid },
        create: {
          vendor_uuid: vendorUuid,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: expiresAt,
        },
        update: {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token ?? undefined,
          expires_at: expiresAt,
        },
      });

      return reply
        .type("text/html")
        .send("<html><body><h3>Connected. You can close this tab.</h3></body></html>");
    }
  );
};
