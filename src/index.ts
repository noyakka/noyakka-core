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
    required: ["PORT", "VAPI_BEARER_TOKEN", "SERVICEM8_BASE_URL", "SERVICEM8_API_KEY"],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_BASE_URL: { type: "string" },
      SERVICEM8_API_KEY: { type: "string" }
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
    // ---- AUTH ----
    const token = extractBearerToken(request.headers);

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
      const customerPayload = { first_name, last_name, mobile };
      fastify.log.info({ customerPayload }, "ServiceM8 customer payload");
      const customerRes = await sm8.post("/company.json", JSON.stringify(customerPayload));

      const company_uuid = customerRes.data.uuid;

      // ---- CREATE JOB ----
      const jobPayload = {
        company_uuid,
        job_description,
        job_address,
        status: "Quote",
        generated_by: "Noyakka AI",
      };
      fastify.log.info({ jobPayload }, "ServiceM8 job payload");
      const jobRes = await sm8.post("/job.json", JSON.stringify(jobPayload));

      const job_uuid = jobRes.data.uuid;
      const job_number = jobRes.data.job_number;

      // ---- ADD JOB NOTE ----
      const notePayload = {
        job_uuid,
        note: `📞 Booked by Noyakka AI\nUrgency: ${urgency}\nDescription: ${job_description}`,
      };
      fastify.log.info({ notePayload }, "ServiceM8 note payload");
      await sm8.post("/jobactivity.json", JSON.stringify(notePayload));

      return reply.send({
        ok: true,
        job_number,
        job_uuid,
      });
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;

      fastify.log.error({ status, data }, "ServiceM8 error");

      return reply.status(500).send({
        ok: false,
        error: "servicem8_error",
        servicem8_status: status,
        servicem8_body: data,
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
