import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createServiceM8Client } from "../servicem8";

type SendSmsBody = {
  mobile?: string;
  message?: string;
  job_uuid?: string;
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

    const { mobile, message, job_uuid } = request.body || {};
    if (!mobile || !message) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    const sm8 = createServiceM8Client(fastify.config);
    const note = `📩 SMS pending\nTo: ${mobile}\nMessage: ${message}`;

    fastify.log.info(
      { job_uuid, mobile: mask(mobile) },
      "Vapi send-sms request received"
    );

    if (!job_uuid) {
      return reply.send({ ok: true, status: "sms_pending", job_uuid: null });
    }

    try {
      await sm8.postJson("/jobactivity.json", {
        job_uuid,
        staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
        type: "note",
        note,
      });

      return reply.send({ ok: true, status: "sms_pending", job_uuid });
    } catch (err: any) {
      return reply.status(500).send({
        ok: false,
        error: "servicem8_error",
        servicem8_status: err.status,
        servicem8_body: err.data,
      });
    }
  };
