import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { sendServiceM8Sms } from "../lib/servicem8-sms";
import { extractVapiArgs } from "../lib/vapi/extract";
import { normalizeVapiArgs } from "../lib/vapi/normalize";
import { vapiSendSmsSchema } from "../lib/vapi/validate";
import { buildValidationPayload, finalizeVapi, logVapiStart } from "../lib/vapi/runtime";

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
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/send-sms";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiSendSmsSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      mobile: normalized.mobile,
      message: normalized.message,
      regarding_job_uuid: normalized.regarding_job_uuid,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    fastify.log.info(
      { servicem8_vendor_uuid: validation.data.vendor_uuid, mobile: mask(validation.data.mobile) },
      "Vapi send-sms request received"
    );

    try {
      await sendServiceM8Sms({
        companyUuid: validation.data.vendor_uuid,
        toMobile: validation.data.mobile,
        message: validation.data.message,
        regardingJobUuid: validation.data.regarding_job_uuid,
      });
      return finalizeVapi(fastify, reply, context, { ok: true }, true);
    } catch (err: any) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "ServiceM8 SMS failed",
          servicem8_status: err.status,
          servicem8_body: err.data,
        },
        false,
        "INTERNAL_ERROR"
      );
    }
  };
