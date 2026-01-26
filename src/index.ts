import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { createServiceM8Client } from "./servicem8";

// Start server
const start = async () => {
  const fastify = Fastify({
    logger: true
  });

  // Register CORS
  await fastify.register(cors, {
    origin: true
  });

  // Register env plugin
  const envSchema = {
    type: "object",
    required: [
      "PORT",
      "VAPI_BEARER_TOKEN",
      "SERVICEM8_BASE_URL",
      "SERVICEM8_API_KEY",
      "SERVICEM8_STAFF_UUID",
      "SERVICEM8_QUEUE_UUID",
      "SERVICEM8_CATEGORY_UUID",
    ],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_BASE_URL: { type: "string" },
      SERVICEM8_API_KEY: { type: "string" },
      SERVICEM8_STAFF_UUID: { type: "string" },
      SERVICEM8_QUEUE_UUID: { type: "string" },
      SERVICEM8_CATEGORY_UUID: { type: "string" },
    }
  };

  await fastify.register(env, {
    schema: envSchema,
    dotenv: true
  });

  const requiredEnv = [
    "SERVICEM8_API_KEY",
    "SERVICEM8_QUEUE_UUID",
    "SERVICEM8_CATEGORY_UUID",
  ] as const;
  for (const key of requiredEnv) {
    if (!fastify.config[key]) {
      fastify.log.error({ missingEnv: key }, "Missing required ServiceM8 env var");
      throw new Error(`Missing required ServiceM8 env var: ${key}`);
    }
  }

  const extractBearerToken = (headers: typeof fastify['raw']['headers']) => {
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

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return { ok: true };
  });

  // Vapi ping endpoint with auth
  fastify.post('/vapi/ping', async (request, reply) => {
    const token = extractBearerToken(request.headers);

    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true });
  });

  // Vapi create-job endpoint
  fastify.post('/vapi/create-job', async (request, reply) => {
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const {
      first_name,
      last_name,
      mobile,
      job_address,
      job_description,
      urgency = "this_week"
    } = request.body as any;
    if (!first_name || !last_name || !mobile || !job_address || !job_description) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    const sm8 = createServiceM8Client(fastify.config);
    const mask = (value: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

    try {
      // ServiceM8 /company.json expects "name" at minimum (not first_name/last_name)
      const name = `${first_name} ${last_name}`.trim();

      // 1) Try find existing customer by mobile (best identifier)
      let company_uuid: string | null = null;

      try {
        // ServiceM8 supports list endpoints with query params like ?search=
        const searchUrl = `${fastify.config.SERVICEM8_BASE_URL}/company.json?search=${encodeURIComponent(mobile)}`;
        const res = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "X-Api-Key": fastify.config.SERVICEM8_API_KEY,
            "Accept": "application/json",
          },
        });

        if (res.ok) {
          const list = await res.json();
          // list is usually an array of companies
          if (Array.isArray(list) && list.length > 0) {
            company_uuid = list[0].uuid || list[0].company_uuid || null;
          }
        }
      } catch {
        // ignore search failures and fall back to create
      }

      // 2) If not found, create new company with a unique name
      if (!company_uuid) {
        const uniqueName = `${name} (${mobile})`; // guarantees uniqueness
        const companyCreate = await sm8.postJson("/company.json", {
          name: uniqueName,
          // address: job_address,
        });

        company_uuid = companyCreate.recordUuid;
      }

      const brandedDescription = `[NOYAKKA] ${job_description}`.trim();
      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID;

      fastify.log.info(
        {
          queue_uuid,
          category_uuid,
          mobile: mask(mobile),
          job_address: mask(job_address),
        },
        "ServiceM8 create-job payload metadata"
      );

      const jobCreate = await sm8.postJson("/job.json", {
        company_uuid,
        job_description: brandedDescription,
        job_address,
        status: "Quote",
        queue_uuid,
        category_uuid,
      });

      const job_uuid = jobCreate.recordUuid;

      await sm8.postJson("/jobactivity.json", {
        job_uuid,
        staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
        note: `📞 Booked by Noyakka AI\nUrgency: ${urgency}\nDescription: ${job_description}`,
      });

      let job_number: string | number | null = null;
      try {
        const jobGet = await sm8.getJson(`/job/${job_uuid}.json`);
        job_number =
          jobGet.data?.job_number ??
          jobGet.data?.generated_job_id ??
          jobGet.data?.job_no ??
          null;
      } catch (err: any) {
        fastify.log.error(
          { status: err?.status, data: err?.data, job_uuid },
          "ServiceM8 job lookup failed"
        );
      }

      return reply.send({
        ok: true,
        job_uuid,
        job_number,
        company_uuid,
        queue_uuid,
        category_uuid,
      });
    } catch (err: any) {
      return reply.status(500).send({
        ok: false,
        error: "servicem8_error",
        servicem8_status: err.status,
        servicem8_body: err.data,
      });
    }
  });

  try {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`Server listening on ${host}:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
