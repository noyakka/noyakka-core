import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { buildCreateLeadHandler } from "./routes/vapi.create-lead";
import { buildSendSmsHandler } from "./routes/vapi.send-sms";
import { registerServiceM8AuthRoutes } from "./routes/auth.servicem8";
import prisma from "./lib/prisma";
import { getServiceM8Client } from "./lib/servicem8-oauth";
import { sendServiceM8Sms } from "./lib/servicem8-sms";

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
      "SERVICEM8_APP_ID",
      "SERVICEM8_APP_SECRET",
    ],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_APP_ID: { type: "string" },
      SERVICEM8_APP_SECRET: { type: "string" },
      BASE_URL: { type: "string" },
      SERVICEM8_STAFF_UUID: { type: "string" },
      SERVICEM8_QUEUE_UUID: { type: "string" },
      SERVICEM8_CATEGORY_UUID: { type: "string" },
      DATABASE_URL: { type: "string" },
    }
  };

  await fastify.register(env, {
    schema: envSchema,
    dotenv: true
  });

  const requiredEnv = ["SERVICEM8_APP_ID", "SERVICEM8_APP_SECRET"] as const;
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

  registerServiceM8AuthRoutes(fastify);

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return { ok: true };
  });

  fastify.get("/debug/oauth-connections", async (_request, reply) => {
    const count = await prisma.serviceM8Connection.count();
    const latest = await prisma.serviceM8Connection.findFirst({
      orderBy: { updated_at: "desc" },
    });

    return reply.send({
      ok: true,
      count,
      latest_servicem8_vendor_uuid: latest?.vendor_uuid ?? null,
      latest_expires_at: latest?.expires_at ?? null,
    });
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
  fastify.post('/vapi/create-job', {
    schema: {
      body: {
        type: "object",
        required: ["servicem8_vendor_uuid", "first_name", "last_name", "mobile", "job_address", "job_description"],
        properties: {
          servicem8_vendor_uuid: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          mobile: { type: "string" },
          job_address: { type: "string" },
          job_description: { type: "string" },
          urgency: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const {
      servicem8_vendor_uuid,
      first_name,
      last_name,
      mobile,
      job_address,
      job_description,
      urgency = "this_week"
    } = request.body as any;
    if (!servicem8_vendor_uuid || !first_name || !last_name || !mobile || !job_address || !job_description) {
      return reply.status(400).send({ ok: false, error: "missing required fields" });
    }

    const sm8 = await getServiceM8Client(servicem8_vendor_uuid);
    const mask = (value: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

    try {
      const brandedDescription = `[NOYAKKA] ${job_description}`.trim();
      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID || undefined;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID || undefined;

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
        ...(queue_uuid ? { queue_uuid } : {}),
        ...(category_uuid ? { category_uuid } : {}),
      });

      const job_uuid = jobCreate.recordUuid;

      await sm8.postJson("/jobcontact.json", {
        job_uuid,
        type: "Job Contact",
        first_name,
        last_name,
        mobile,
      });

      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📞 Booked by Noyakka AI\nUrgency: ${urgency}\nDescription: ${job_description}`,
        });
      }

      let generated_job_id: string | number | null = null;
      try {
        const jobGet = await sm8.getJson(`/job/${job_uuid}.json`);
        generated_job_id =
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

      let sms_sent = false;
      if (generated_job_id) {
        try {
          await sendServiceM8Sms({
            companyUuid: servicem8_vendor_uuid,
            toMobile: mobile,
            message: `G’day ${first_name}. Your job #${generated_job_id} is logged. We’ll confirm timing shortly.`,
            regardingJobUuid: job_uuid,
          });
          sms_sent = true;
        } catch (err: any) {
          if (fastify.config.SERVICEM8_STAFF_UUID) {
            await sm8.postJson("/jobactivity.json", {
              job_uuid,
              staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
              type: "note",
              note: "⚠️ SMS confirmation failed",
            });
          }
        }
      }

      return reply.send({
        ok: true,
        job_uuid,
        generated_job_id,
        sms_sent,
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

  // Vapi create-lead endpoint (job + contact + note)
  fastify.post("/vapi/create-lead", {
    schema: {
      body: {
        type: "object",
        required: ["company_uuid", "first_name", "last_name", "mobile", "job_address", "job_description"],
        properties: {
          company_uuid: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          mobile: { type: "string" },
          email: { type: "string" },
          job_address: { type: "string" },
          job_description: { type: "string" },
          urgency: { type: "string" },
          call_summary: { type: "string" },
        },
      },
    },
  }, buildCreateLeadHandler(fastify));

  // Vapi send-sms endpoint (logs SMS pending)
  fastify.post("/vapi/send-sms", {
    schema: {
      body: {
        type: "object",
        required: ["servicem8_vendor_uuid", "to_mobile", "message"],
        properties: {
          servicem8_vendor_uuid: { type: "string" },
          to_mobile: { type: "string" },
          message: { type: "string" },
          regarding_job_uuid: { type: "string" },
        },
      },
    },
  }, buildSendSmsHandler(fastify));

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
