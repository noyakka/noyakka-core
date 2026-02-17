import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { getServiceM8Client } from "../lib/servicem8-oauth";
import { sendServiceM8Sms } from "../lib/servicem8-sms";
import { extractVapiArgs } from "../lib/vapi/extract";
import { normalizeVapiArgs, normalizeUrgency as normalizeVapiUrgency } from "../lib/vapi/normalize";
import { vapiCreateLeadSchema } from "../lib/vapi/validate";
import { buildValidationPayload, finalizeVapi, logVapiStart } from "../lib/vapi/runtime";
import { finishToolRunFailure, finishToolRunSuccess, getOrStartToolRun } from "../lib/idempotency";

type CreateLeadBody = {
  servicem8_vendor_uuid?: string;
  company_uuid?: string;
  first_name?: string;
  last_name?: string;
  mobile?: string;
  email?: string;
  job_address?: string;
  job_description?: string;
  urgency?: string;
  call_summary?: string;
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
const maskEmail = (value?: string) => {
  if (!value) return "";
  const [name, domain] = value.split("@");
  if (!domain) return mask(value);
  return `${name.slice(0, 2)}***@${domain}`;
};

export const buildCreateLeadHandler =
  (fastify: FastifyInstance) =>
  async (request: FastifyRequest<{ Body: CreateLeadBody }>, reply: FastifyReply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/create-lead";
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

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    if (!normalized.call_id) {
      const payload = {
        ok: false,
        error_code: "VALIDATION_ERROR",
        message: "Missing call_id",
        missing_fields: ["call_id"],
        normalized_preview: normalized,
      };
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code);
    }

    const validation = vapiCreateLeadSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const { run, replayResult } = await getOrStartToolRun(
      validation.data.vendor_uuid,
      endpoint,
      normalized.call_id
    );
    if (replayResult) {
      return finalizeVapi(fastify, reply, context, replayResult as any, true);
    }

    const sm8 = await getServiceM8Client(validation.data.vendor_uuid);
    const postWithLog = async (path: string, body: Record<string, unknown>) => {
      try {
        return await sm8.postJson(path, body);
      } catch (err: any) {
        fastify.log.error(
          {
            url: `https://api.servicem8.com/api_1.0${path}`,
            body: {
              ...body,
              mobile: mask(body.mobile as string | undefined),
              email: maskEmail(body.email as string | undefined),
              value: mask(body.value as string | undefined),
            },
            servicem8_status: err?.status,
            servicem8_body: err?.data,
          },
          "ServiceM8 request failed"
        );
        throw err;
      }
    };

    try {
      const name = `${validation.data.first_name} ${validation.data.last_name}`.trim();
      const uniqueName = `${name} (${validation.data.mobile})`;

      let company_uuid: string | null = null;
      try {
        const searchRes = await sm8.getJson(`/company.json?search=${encodeURIComponent(validation.data.mobile)}`);
        if (Array.isArray(searchRes.data) && searchRes.data.length > 0) {
          company_uuid = searchRes.data[0].uuid || searchRes.data[0].company_uuid || null;
        }
      } catch {
        // ignore search failures and fall back to create
      }

      if (!company_uuid) {
        const companyCreate = await postWithLog("/company.json", {
          name: uniqueName,
        });
        company_uuid = companyCreate.recordUuid;
      }
      if (!company_uuid) {
        const payload = {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "ServiceM8 company lookup failed",
        };
        await finishToolRunFailure(run.id, "INTERNAL_ERROR");
        return finalizeVapi(fastify, reply, context, payload, false, "INTERNAL_ERROR");
      }

      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID || undefined;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID || undefined;
      const brandedDescription = `[NOYAKKA] ${validation.data.job_description}`.trim();
      const jobAddress = validation.data.address?.full
        ?? [validation.data.address?.street_number, validation.data.address?.street_name, validation.data.address?.suburb]
          .filter(Boolean)
          .join(" ");

      fastify.log.info(
        {
          queue_uuid,
          category_uuid,
          mobile: mask(validation.data.mobile),
          job_address: mask(jobAddress),
        },
        "ServiceM8 create-lead payload metadata"
      );

      const jobCreate = await postWithLog("/job.json", {
        company_uuid,
        job_description: brandedDescription,
        job_address: jobAddress,
        status: "Quote",
        ...(queue_uuid ? { queue_uuid } : {}),
        ...(category_uuid ? { category_uuid } : {}),
      });

      const job_uuid = jobCreate.recordUuid;
      if (!job_uuid) {
        const payload = {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "ServiceM8 job creation failed",
        };
        await finishToolRunFailure(run.id, "INTERNAL_ERROR");
        return finalizeVapi(fastify, reply, context, payload, false, "INTERNAL_ERROR");
      }

      await postWithLog("/jobcontact.json", {
        job_uuid,
        type: "Job Contact",
        first_name: validation.data.first_name,
        last_name: validation.data.last_name,
        mobile: validation.data.mobile,
        email: validation.data.email,
      });

      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await postWithLog("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📞 Booked by Noyakka AI\nUrgency: ${validation.data.urgency}\nSummary: ${validation.data.call_summary ?? ""}\nDescription: ${validation.data.job_description}`,
        });
      }

      let generated_job_id: string | number | null = null;
      try {
        const jobGet = await sm8.getJson(`/job/${job_uuid}.json`);
        generated_job_id =
          jobGet.data?.generated_job_id ??
          jobGet.data?.job_number ??
          jobGet.data?.job_no ??
          null;
      } catch (err: any) {
        fastify.log.error(
          { status: err?.status, data: err?.data, job_uuid },
          "ServiceM8 job lookup failed"
        );
      }

      const smsMessage = `G’day ${validation.data.first_name}. Job #${generated_job_id ?? "pending"} is logged. We’ll confirm timing shortly.`;
      try {
        await sendServiceM8Sms({
          companyUuid: validation.data.vendor_uuid,
          toMobile: validation.data.mobile,
          message: smsMessage,
          regardingJobUuid: job_uuid,
        });
      } catch (err: any) {
        fastify.log.error(
          { status: err?.status, data: err?.data, job_uuid },
          "ServiceM8 SMS send failed"
        );
      }

      const payload = {
        ok: true,
        job_uuid,
        generated_job_id,
        company_uuid,
      };
      await finishToolRunSuccess(run.id, payload);
      return finalizeVapi(fastify, reply, context, payload, true);
    } catch (err: any) {
      const payload = {
        ok: false,
        error_code: "INTERNAL_ERROR",
        message: "ServiceM8 error",
        servicem8_status: err.status,
        servicem8_body: err.data,
      };
      await finishToolRunFailure(run.id, "INTERNAL_ERROR");
      return finalizeVapi(fastify, reply, context, payload, false, "INTERNAL_ERROR");
    }
  };
