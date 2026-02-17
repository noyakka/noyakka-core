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

      // Use BASE_URL from env, or derive from request (for local dev without .env)
      const host = request.headers.host || "";
      const protocol = (request.headers["x-forwarded-proto"] as string) || request.protocol || "http";
      const requestOrigin = host ? `${protocol}://${host}`.replace(/\/$/, "") : "";
      const redirectBase = fastify.config.BASE_URL || requestOrigin || "https://noyakka-core.fly.dev";
      const redirectUri = `${redirectBase}/auth/servicem8/callback`;

      await prisma.oAuthState.create({
        data: {
          state,
          vendor_uuid,
          redirect_uri: redirectUri,
          expires_at: expiresAt,
        },
      });
      const scope = [
        "vendor",
        "read_staff",
        "create_jobs",
        "read_jobs",
        "manage_customers",
        "manage_job_contacts",
        "manage_schedule",
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
      try {
        return await handleCallback(request, reply, fastify);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err, message: msg }, "OAuth callback error");
        return reply.status(500).type("text/html").send(`
          <html><body>
            <h3>OAuth Error</h3>
            <p><strong>${escapeHtml(msg)}</strong></p>
            <p>Check the server terminal for full details.</p>
          </body></html>`);
      }
    }
  );
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function handleCallback(
  request: FastifyRequest<{ Querystring: CallbackQuery }>,
  reply: FastifyReply,
  fastify: FastifyInstance
) {
  const { code, state } = request.query;
      if (!code || !state) {
        return reply.status(400).send("Missing code or state");
      }

      const record = await prisma.oAuthState.findUnique({ where: { state } });
      if (!record || record.expires_at.getTime() < Date.now()) {
        return reply.status(400).send("Invalid or expired state");
      }

      // Use the exact redirect_uri stored at /start (ensures callback hits same server)
      const redirectUri = record.redirect_uri;
      await prisma.oAuthState.delete({ where: { state } });
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
        const errMsg = (tokenData as { error?: string; error_description?: string }).error_description ?? (tokenData as { error?: string }).error ?? "ServiceM8 token exchange failed";
        return reply.status(500).type("text/html").send(`<html><body><h3>Token exchange failed</h3><p>${escapeHtml(String(errMsg))}</p></body></html>`);
      }

      const authHeaders = {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/json",
      };

      let vendorData: unknown;
      let vendorStatus = 0;
      const vendorRes = await fetch("https://api.servicem8.com/api_1.0/vendor.json", {
        method: "GET",
        headers: authHeaders,
      });
      vendorData = await vendorRes.json();
      vendorStatus = vendorRes.status;

      // Fallback when vendor.json returns 402: try staff.json (some account types include vendor in staff)
      if (vendorStatus === 402) {
        const staffRes = await fetch("https://api.servicem8.com/api_1.0/staff.json", {
          method: "GET",
          headers: authHeaders,
        });
        if (staffRes.ok) {
          const staffData = (await staffRes.json()) as unknown[];
          const firstStaff = Array.isArray(staffData) ? staffData[0] : null;
          const staffObj = firstStaff && typeof firstStaff === "object" ? (firstStaff as Record<string, unknown>) : null;
          const fromStaff = typeof staffObj?.vendor_uuid === "string" ? staffObj.vendor_uuid : null;
          if (fromStaff) {
            vendorData = [{ uuid: fromStaff }];
            vendorStatus = 200;
          }
        }
      }

      const first = Array.isArray(vendorData) ? vendorData[0] : vendorData;
      const root = vendorData && typeof vendorData === "object" ? (vendorData as Record<string, unknown>) : null;
      const obj = first && typeof first === "object" ? (first as Record<string, unknown>) : root;
      let vendorUuid =
        (typeof obj?.uuid === "string" ? obj.uuid : null) ??
        (typeof obj?.vendor_uuid === "string" ? obj.vendor_uuid : null) ??
        (typeof root?.vendor === "object" && root?.vendor && typeof (root.vendor as Record<string, unknown>).uuid === "string"
          ? ((root.vendor as Record<string, unknown>).uuid as string)
          : null) ??
        (typeof (tokenData as { vendor_uuid?: string }).vendor_uuid === "string"
          ? (tokenData as { vendor_uuid: string }).vendor_uuid
          : null);

      if (!vendorUuid) {
        const logMeta: Record<string, unknown> = {
          vendorStatus: vendorStatus,
          vendorDataKeys: vendorData && typeof vendorData === "object" ? Object.keys(vendorData as object) : [],
        };
        if (vendorData && typeof vendorData === "object" && !Array.isArray(vendorData)) {
          const d = vendorData as Record<string, unknown>;
          logMeta.vendorSample = {
            uuid: d.uuid,
            vendor_uuid: d.vendor_uuid,
            error: d.error,
            message: d.message,
          };
        } else if (Array.isArray(vendorData) && vendorData[0]) {
          const d = vendorData[0] as Record<string, unknown>;
          logMeta.vendorSample = { uuid: d.uuid, vendor_uuid: d.vendor_uuid };
        }
        fastify.log.warn(logMeta, "ServiceM8 vendor lookup failed");

        let hint = "";
        if (vendorStatus === 402) {
          hint =
            " 402 Payment Required usually means the ServiceM8 account (or developer app) needs a paid subscription for vendor API access. Free trials may have limited API access. Try: (1) Upgrade the ServiceM8 account to a paid plan, (2) Use a different ServiceM8 account that has an active subscription, or (3) Contact ServiceM8 support (support@servicem8.com) to request vendor API access for your trial.";
        } else if (vendorStatus === 403) {
          hint =
            " 403 usually means the \"vendor\" scope was not approved. Clear your app connection in ServiceM8 (Add-ons) and run the OAuth flow again, approving all requested permissions.";
        } else if (vendorStatus === 401) {
          hint = " 401 means the token was rejected. This can happen if the authorization code was already used or expired.";
        } else if (Array.isArray(vendorData) && vendorData.length === 0) {
          hint = " Vendor API returned an empty array. Your developer app may need to be fully activated.";
        }
        const msg =
          `Missing vendor uuid from ServiceM8. Vendor API returned ${vendorStatus}. ` +
          `Ensure the "vendor" scope is granted and you approved all permissions.${hint} Restart the OAuth flow and check server logs.`;
        return reply.status(500).type("text/html").send(
          `<html><body><h3>Vendor lookup failed</h3><p>${escapeHtml(msg)}</p></body></html>`
        );
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
