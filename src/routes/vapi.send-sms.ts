import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getServiceM8Client } from "../lib/servicem8-oauth";

type SendSmsBody = {
  company_uuid?: string;
  to_mobile?: string;
  message?: string;
};

const extractBearerToken = (headers: FastifyRequest["headers"]) => {
  const authHeader = headers.authorization;
  const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader || "";
  if (authValue) {
    if (authValue.toLowerCase().startsWith("bearer ")) {
      return authValue.slice(7);
    }
    return authValue;
  }

  const altHeader = headers["x-vapi-token"] ?? headers["x-api-key"];
  const altValue = Array.isArray(altHeader) ? altHeader[0] : altHeader || "";
  return altValue;
};

const mask = (value?: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

export const buildSendSmsHandler =
  (fastify: FastifyInstance) =>
  async (request: FastifyRequest<{ Body: SendSmsBody }>, reply: FastifyReply) => {
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const { company_uuid, to_mobile, message } = request.body || {};
    if (!company_uuid || !to_mobile || !message) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    fastify.log.info(
      { company_uuid, mobile: mask(to_mobile) },
      "Vapi send-sms request received"
    );

    await getServiceM8Client(company_uuid);

    return reply.status(501).send({
      ok: false,
      error: "sms_not_supported",
      hint: "Integrate Twilio next",
    });
  };
