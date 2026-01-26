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
    required: ["PORT", "VAPI_BEARER_TOKEN", "SERVICEM8_BASE_URL", "SERVICEM8_API_KEY", "SERVICEM8_STAFF_UUID"],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_BASE_URL: { type: "string" },
      SERVICEM8_API_KEY: { type: "string" },
      SERVICEM8_STAFF_UUID: { type: "string" }
    }
  };

  await fastify.register(env, {
    schema: envSchema,
    dotenv: true
  });

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

    try {
      // ServiceM8 /company.json expects "name" at minimum (not first_name/last_name)
      const name = `${first_name} ${last_name}`.trim();

      let company_uuid: string | null = null;
      try {
        const companyCreate = await sm8.postJson("/company.json", {
          name,
          // address: job_address,
        });
        company_uuid = companyCreate.recordUuid;
      } catch (err: any) {
        if (err?.data?.message?.includes("Name must be unique")) {
          const searchName = encodeURIComponent(name);
          const searchRes = await sm8.getJson(`/company.json?search=${searchName}`);
          const match = Array.isArray(searchRes.data)
            ? searchRes.data.find((item: any) => item?.name === name)
            : null;
          company_uuid = match?.uuid || null;
        } else {
          throw err;
        }
      }

      if (!company_uuid) {
        return reply.status(500).send({
          ok: false,
          error: "servicem8_error",
          servicem8_status: 400,
          servicem8_body: { message: "Company not found after unique name error" },
        });
      }

      const jobCreate = await sm8.postJson("/job.json", {
        company_uuid,
        job_description,
        job_address,
        status: "Quote",
      });

      const job_uuid = jobCreate.recordUuid;

      await sm8.postJson("/jobactivity.json", {
        job_uuid,
        staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
        note: `📞 Booked by Noyakka AI\nUrgency: ${urgency}\nDescription: ${job_description}`,
      });

      return reply.send({ ok: true, job_uuid });
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
