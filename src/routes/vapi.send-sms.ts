import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sendServiceM8Sms } from "../lib/servicem8-sms";

type SendSmsBody = {
  servicem8_vendor_uuid?: string;
  to_mobile?: string;
  message?: string;
  regarding_job_uuid?: string;
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

    const { servicem8_vendor_uuid, to_mobile, message, regarding_job_uuid } = request.body || {};
    if (!servicem8_vendor_uuid || !to_mobile || !message) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    fastify.log.info(
      { servicem8_vendor_uuid, mobile: mask(to_mobile) },
      "Vapi send-sms request received"
    );

    try {
      await sendServiceM8Sms({
        companyUuid: servicem8_vendor_uuid,
        toMobile: to_mobile,
        message,
        regardingJobUuid: regarding_job_uuid,
      });
      return reply.send({ ok: true });
    } catch (err: any) {
      return reply.status(500).send({
        ok: false,
        error: "servicem8_sms_failed",
        servicem8_status: err.status,
        servicem8_body: err.data,
      });
    }
  };
