import type { FastifyInstance, FastifyReply } from "fastify";
import { push as pushVapiRing } from "../debug/vapiRing";
import type { NormalizedVapiArgs } from "./normalize";
import { formatZodError } from "./validate";
import type { ZodError } from "zod";

export type VapiContext = {
  request_id: string;
  endpoint: string;
  vendor_uuid?: string;
  call_id?: string;
  tool_name?: string;
  normalized?: NormalizedVapiArgs;
  started_at: number;
  disable_result_envelope?: boolean;
};

export const logVapiStart = (fastify: FastifyInstance, context: VapiContext) => {
  fastify.log.info(
    {
      request_id: context.request_id,
      endpoint: context.endpoint,
      vendor_uuid: context.vendor_uuid,
      call_id: context.call_id,
      tool_name: context.tool_name,
    },
    "Vapi request start"
  );
};

export const buildValidationPayload = (normalized: NormalizedVapiArgs | undefined, error: ZodError) => {
  const { message, missing_fields } = formatZodError(error);
  return {
    ok: false,
    error_code: "VALIDATION_ERROR",
    message,
    missing_fields,
    normalized_preview: normalized ?? {},
  };
};

export const finalizeVapi = (
  fastify: FastifyInstance,
  reply: FastifyReply,
  context: VapiContext,
  payload: Record<string, unknown>,
  ok: boolean,
  error_code?: string
) => {
  const duration_ms = Date.now() - context.started_at;
  fastify.log.info(
    {
      request_id: context.request_id,
      endpoint: context.endpoint,
      vendor_uuid: context.vendor_uuid,
      call_id: context.call_id,
      tool_name: context.tool_name,
      ok,
      error_code,
      duration_ms,
    },
    "Vapi request end"
  );
  if (error_code === "UNAUTHORIZED") {
    fastify.log.warn(
      {
        request_id: context.request_id,
        endpoint: context.endpoint,
        call_id: context.call_id,
      },
      "Vapi authorization failed"
    );
  }
  pushVapiRing({
    request_id: context.request_id,
    endpoint: context.endpoint,
    vendor_uuid: context.vendor_uuid,
    call_id: context.call_id,
    tool_name: context.tool_name,
    normalized_urgency: context.normalized?.urgency,
    ok,
    error_code,
    duration_ms,
    normalized_preview: context.normalized,
  });

  const responsePayload: Record<string, unknown> = { ...payload };
  let textResult: string | undefined;
  if (typeof responsePayload.result === "string") {
    textResult = responsePayload.result;
  } else if (typeof responsePayload.message === "string") {
    textResult = responsePayload.message;
  } else if (ok && Array.isArray(responsePayload.options)) {
    const options = responsePayload.options as Array<Record<string, unknown>>;
    if (options.length > 0) {
      const labels = options
        .slice(0, 3)
        .map((option) => (typeof option.label === "string" ? option.label : null))
        .filter((label): label is string => Boolean(label));
      textResult = labels.length > 0 ? `Available: ${labels.join(", ")}` : "Availability returned";
    } else {
      textResult = "No options available right now";
    }
  } else if (ok) {
    textResult = "Success";
  } else {
    const errorCode = typeof responsePayload.error_code === "string" ? responsePayload.error_code : "ERROR";
    const message = typeof responsePayload.message === "string" ? responsePayload.message : "Request failed";
    textResult = `${errorCode}: ${message}`;
  }

  if (!context.disable_result_envelope) {
    if (!("result" in responsePayload)) {
      responsePayload.result = textResult;
    }
    if (!("results" in responsePayload) && context.call_id) {
      responsePayload.results = [
        {
          toolCallId: context.call_id,
          result: textResult,
        },
      ];
    }
  }

  return reply
    .status(200)
    .header("Content-Type", "application/json; charset=utf-8")
    .send(responsePayload);
};
