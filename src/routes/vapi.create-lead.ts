import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getServiceM8Client } from "../lib/servicem8-oauth";
import { sendServiceM8Sms } from "../lib/servicem8-sms";

type CreateLeadBody = {
  servicem8_vendor_uuid?: string;
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
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const {
      servicem8_vendor_uuid: tenant_vendor_uuid,
      first_name,
      last_name,
      mobile,
      email,
      job_address,
      job_description,
      urgency = "this_week",
      call_summary = "",
    } = request.body || {};

    if (!tenant_vendor_uuid || !first_name || !last_name || !mobile || !job_address || !job_description) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    const sm8 = await getServiceM8Client(tenant_vendor_uuid);
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
      const name = `${first_name} ${last_name}`.trim();
      const uniqueName = `${name} (${mobile})`;

      let company_uuid: string | null = null;
      try {
        const searchRes = await sm8.getJson(`/company.json?search=${encodeURIComponent(mobile)}`);
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
        return reply.status(500).send({ ok: false, error: "servicem8_error" });
      }

      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID || undefined;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID || undefined;
      const brandedDescription = `[NOYAKKA] ${job_description}`.trim();

      fastify.log.info(
        {
          queue_uuid,
          category_uuid,
          mobile: mask(mobile),
          job_address: mask(job_address),
        },
        "ServiceM8 create-lead payload metadata"
      );

      const jobCreate = await postWithLog("/job.json", {
        company_uuid,
        job_description: brandedDescription,
        job_address,
        status: "Quote",
        ...(queue_uuid ? { queue_uuid } : {}),
        ...(category_uuid ? { category_uuid } : {}),
      });

      const job_uuid = jobCreate.recordUuid;
      if (!job_uuid) {
        return reply.status(500).send({ ok: false, error: "servicem8_error" });
      }

      await postWithLog("/jobcontact.json", {
        job_uuid,
        type: "Job Contact",
        first_name: first_name,
        last_name: last_name,
        mobile: mobile,
        email: email,
      });

      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await postWithLog("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📞 Booked by Noyakka AI\nUrgency: ${urgency}\nSummary: ${call_summary}\nDescription: ${job_description}`,
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

      const smsMessage = `G’day ${first_name}. Job #${generated_job_id ?? "pending"} is logged. We’ll confirm timing shortly.`;
      try {
        await sendServiceM8Sms({
          companyUuid: tenant_vendor_uuid,
          toMobile: mobile,
          message: smsMessage,
          regardingJobUuid: job_uuid,
        });
      } catch (err: any) {
        fastify.log.error(
          { status: err?.status, data: err?.data, job_uuid },
          "ServiceM8 SMS send failed"
        );
      }

      return reply.send({
        ok: true,
        job_uuid,
        generated_job_id,
        company_uuid,
      });
    } catch (err: any) {
      return reply.status(500).send({
        ok: false,
        error: "servicem8_error",
        servicem8_status: err.status,
        servicem8_body: err.data,
      });
    }
  };
