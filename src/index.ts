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
    required: ["PORT", "VAPI_BEARER_TOKEN", "SERVICEM8_BASE_URL", "SERVICEM8_EMAIL", "SERVICEM8_PASSWORD"],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_BASE_URL: { type: "string" },
      SERVICEM8_EMAIL: { type: "string" },
      SERVICEM8_PASSWORD: { type: "string" }
    }
  };

  await fastify.register(env, {
    schema: envSchema,
    dotenv: true
  });

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return { ok: true };
  });

  // Vapi ping endpoint with auth
  fastify.post('/vapi/ping', async (request, reply) => {
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true });
  });

  // Vapi create-job endpoint
  fastify.post('/vapi/create-job', async (request, reply) => {
    // ---- AUTH ----
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    // ---- INPUT ----
    const {
      first_name,
      last_name,
      mobile,
      job_address,
      job_description,
      urgency = "this_week",
    } = request.body as any;

    if (!first_name || !last_name || !mobile || !job_address || !job_description) {
      return reply.status(400).send({
        ok: false,
        error: "missing required fields",
      });
    }

    const sm8 = createServiceM8Client(fastify.config);

    try {
      // ---- CREATE CUSTOMER ----
      const customerRes = await sm8.post("/company.json", {
        first_name,
        last_name,
        mobile,
      });

      const company_uuid = customerRes.data.uuid;

      // ---- CREATE JOB ----
      const jobRes = await sm8.post("/job.json", {
        company_uuid,
        job_description,
        job_address,
        status: "Quote",
        generated_by: "Noyakka AI",
      });

      const job_uuid = jobRes.data.uuid;
      const job_number = jobRes.data.job_number;

      // ---- ADD JOB NOTE ----
      await sm8.post("/jobactivity.json", {
        job_uuid,
        note: `📞 Booked by Noyakka AI
Urgency: ${urgency}
Description: ${job_description}`,
      });

      return reply.send({
        ok: true,
        job_number,
        job_uuid,
      });
    } catch (err: any) {
      fastify.log.error(err?.response?.data || err);
      return reply.status(500).send({
        ok: false,
        error: "servicem8_error",
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
