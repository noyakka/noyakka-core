import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { buildCreateLeadHandler } from "./routes/vapi.create-lead";
import { buildSendSmsHandler } from "./routes/vapi.send-sms";
import { registerServiceM8AuthRoutes } from "./routes/auth.servicem8";
import prisma from "./lib/prisma";
import { getServiceM8Client } from "./lib/servicem8-oauth";
import { sendServiceM8Sms } from "./lib/servicem8-sms";

let lastVapiCall: { at: string; body: unknown } | null = null;

const extractVapiArgs = (body: any) => {
  if (!body || typeof body !== "object") {
    return body;
  }

  const wrapper = body.message?.toolCalls?.[0]?.function?.arguments;
  if (wrapper && typeof wrapper === "object") {
    return wrapper;
  }
  if (typeof wrapper === "string") {
    try {
      return JSON.parse(wrapper);
    } catch {
      return body;
    }
  }

  return body;
};

const getBrisbaneHour = () => {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = parts.find((part) => part.type === "hour")?.value;
  return hour ? Number(hour) : new Date().getUTCHours();
};

const getAvailabilityForToday = () => {
  const cutoffHour = 15;
  const hour = getBrisbaneHour();
  if (hour < cutoffHour) {
    return { available: true, window: "today", message: "We can attend today" };
  }
  return { available: false, window: "tomorrow", message: "Next availability is tomorrow" };
};

const getBrisbaneDateParts = (date: Date) => {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { weekday, hour, minute };
};

const computeAvailabilityWindow = (input: {
  urgency: string;
  nowLocal?: string;
  preferredWindow?: string;
  name?: string;
}) => {
  const now = input.nowLocal ? new Date(input.nowLocal) : new Date();
  const { weekday, hour, minute } = getBrisbaneDateParts(now);
  const isWeekend = weekday === "Sat" || weekday === "Sun";
  const afterCutoff = hour > 14 || (hour === 14 && minute >= 30);
  const preferred = input.preferredWindow === "morning" || input.preferredWindow === "arvo"
    ? input.preferredWindow
    : null;
  const name = input.name || "there";

  if (input.urgency === "quote_only") {
    return {
      ok: true,
      window_code: "quote_only",
      window_label: "Quote only",
      sms_template: `G’day ${name} — we’ve got your request and will send a quote. – Noyakka`,
    };
  }

  if (input.urgency === "this_week") {
    return {
      ok: true,
      window_code: "this_week",
      window_label: "This week",
      sms_template: `G’day ${name} — we can attend this week. We’ll confirm timing shortly. – Noyakka`,
    };
  }

  const buildWindow = (code: string, label: string, emergency: boolean) => ({
    ok: true,
    window_code: code,
    window_label: label,
    sms_template: emergency
      ? `EMERGENCY: G’day ${name} — we can attend ${label}. Reply YES to confirm or NO for the next slot. – Noyakka`
      : `G’day ${name} — we can attend ${label}. Reply YES to confirm or NO for the next slot. – Noyakka`,
  });

  const pickTodayWindow = () => {
    if (preferred === "morning" && hour < 11) {
      return buildWindow("today_morning", "Today morning (8–12)", input.urgency === "emergency");
    }
    return buildWindow("today_arvo", "Today arvo (1–4pm)", input.urgency === "emergency");
  };

  if (isWeekend) {
    return buildWindow("next_business_morning", "Next business day morning (8–12)", input.urgency === "emergency");
  }

  if (afterCutoff) {
    return buildWindow("tomorrow_morning", "Tomorrow morning (8–12)", input.urgency === "emergency");
  }

  return pickTodayWindow();
};

const normalizeMobile = (input: string) => {
  const trimmed = input.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  const normalized = hasPlus ? `+${digits}` : digits;

  if (/^04\d{8}$/.test(normalized)) {
    return `+61${normalized.slice(1)}`;
  }
  if (/^\+614\d{8}$/.test(normalized)) {
    return normalized;
  }
  if (/^614\d{8}$/.test(normalized)) {
    return `+${normalized}`;
  }
  return null;
};

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
      SERVICEM8_VENDOR_UUID: { type: "string" },
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

  fastify.get("/debug/last-vapi-call", async () => {
    return lastVapiCall ?? { ok: false, message: "no calls yet" };
  });

  fastify.post("/vapi/check-availability", {
    schema: {
      body: {
        type: "object",
        required: ["urgency"],
        properties: {
          urgency: { type: "string" },
          servicem8_vendor_uuid: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const body = request.body as any;
    const urgency = body?.urgency;
    if (urgency !== "today") {
      return reply.status(400).send({ ok: false, error: "invalid_urgency" });
    }

    return reply.send(getAvailabilityForToday());
  });

  fastify.post("/vapi/availability-window", {
    schema: {
      body: {
        type: "object",
        required: ["urgency"],
        properties: {
          urgency: { type: "string" },
          now_local: { type: "string" },
          preferred_window: { type: "string" },
          servicem8_vendor_uuid: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const body = extractVapiArgs(request.body);
    const urgency = body?.urgency;
    if (!urgency) {
      return reply.status(400).send({ ok: false, error: "missing_urgency" });
    }

    return reply.send(
      computeAvailabilityWindow({
        urgency,
        nowLocal: body?.now_local,
        preferredWindow: body?.preferred_window,
        name: body?.name,
      })
    );
  });

  fastify.post("/vapi/send-window-sms", {
    schema: {
      body: {
        type: "object",
        required: ["job_uuid", "to_mobile", "customer_first_name", "window_code", "window_label"],
        properties: {
          job_uuid: { type: "string" },
          to_mobile: { type: "string" },
          customer_first_name: { type: "string" },
          window_code: { type: "string" },
          window_label: { type: "string" },
          servicem8_vendor_uuid: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const body = extractVapiArgs(request.body);
    const vendorUuid = body?.servicem8_vendor_uuid ?? fastify.config.SERVICEM8_VENDOR_UUID;
    if (!vendorUuid) {
      return reply.status(400).send({ ok: false, error: "missing_servicem8_vendor_uuid" });
    }

    const { job_uuid, to_mobile, customer_first_name, window_label, window_code } = body || {};
    if (!job_uuid || !to_mobile || !customer_first_name || !window_label || !window_code) {
      return reply.status(400).send({ ok: false, error: "tool_payload_empty" });
    }

    const normalizedMobile = normalizeMobile(to_mobile);
    if (!normalizedMobile) {
      return reply.status(400).send({ ok: false, error: "invalid_mobile" });
    }

    try {
      const message = `G’day ${customer_first_name} — we can attend ${window_label}. Reply YES to confirm or NO for the next slot. – Noyakka`;
      await sendServiceM8Sms({
        companyUuid: vendorUuid,
        toMobile: normalizedMobile,
        message,
        regardingJobUuid: job_uuid,
      });

      const sm8 = await getServiceM8Client(vendorUuid);
      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📅 Proposed window: ${window_label} (${window_code}) (auto)`,
        });
      }

      return reply.send({ ok: true, sms_sent: true });
    } catch (err: any) {
      return reply.status(500).send({
        ok: false,
        error: "servicem8_sms_failed",
        servicem8_status: err?.status,
        servicem8_body: err?.data,
      });
    }
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
        properties: {
          servicem8_vendor_uuid: { type: "string" },
          first_name: { type: "string" },
          last_name: { type: "string" },
          name: { type: "string" },
          mobile: { type: "string" },
          job_address: { type: "string" },
          job_description: { type: "string" },
          urgency: { type: "string" },
        },
      },
    },
  }, async (request, reply) => {
    console.log("[VAPI] create-job HIT", {
      body: request.body,
      headers: {
        auth: request.headers.authorization ? "present" : "missing",
      },
    });

    const body = extractVapiArgs(request.body);

    lastVapiCall = {
      at: new Date().toISOString(),
      body: body ?? null,
    };

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const {
      servicem8_vendor_uuid,
      first_name,
      last_name,
      name,
      mobile,
      job_address,
      job_description,
      urgency = "this_week"
    } = body as any;
    const vendorUuid = servicem8_vendor_uuid ?? fastify.config.SERVICEM8_VENDOR_UUID;
    if (!vendorUuid) {
      return reply.status(400).send({ ok: false, error: "missing_servicem8_vendor_uuid" });
    }
    if (!mobile || !job_address || !job_description || !urgency) {
      fastify.log.error(
        { hasBody: Boolean(request.body), mobile: Boolean(mobile), job_address: Boolean(job_address), job_description: Boolean(job_description), urgency: Boolean(urgency) },
        "Vapi create-job missing required fields"
      );
      return reply.status(400).send({ ok: false, error: "tool_payload_empty" });
    }

    const sm8 = await getServiceM8Client(vendorUuid);
    const mask = (value: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

    try {
      let firstName = first_name?.trim();
      let lastName = last_name?.trim();

      if (!firstName && name) {
        const parts = name.split(" ");
        firstName = parts[0];
        lastName = parts.slice(1).join(" ") || "";
      }

      if (!firstName) {
        firstName = "Customer";
      }

      if (!lastName) {
        lastName = "";
      }

      const normalizedMobile = normalizeMobile(mobile);
      if (!normalizedMobile) {
        return reply.status(400).send({ ok: false, error: "invalid_mobile" });
      }

      const fullName = `${firstName} ${lastName}`.trim();
      const uniqueName = `${fullName || "Noyakka Lead"} (${normalizedMobile})`;
      let company_uuid: string | null = null;

      try {
        const searchRes = await sm8.getJson(`/company.json?search=${encodeURIComponent(normalizedMobile)}`);
        if (Array.isArray(searchRes.data) && searchRes.data.length > 0) {
          company_uuid = searchRes.data[0]?.uuid || searchRes.data[0]?.company_uuid || null;
        }
      } catch {
        // ignore search failures and fall back to create
      }

      if (!company_uuid) {
        const companyCreate = await sm8.postJson("/company.json", { name: uniqueName });
        company_uuid = companyCreate.recordUuid ?? null;
      }

      if (!company_uuid) {
        return reply.status(500).send({
          ok: false,
          error: "servicem8_error",
          servicem8_body: "Failed to create or find company_uuid",
        });
      }

      const brandedDescription = `NOYAKKA — ${job_description}`.trim();
      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID || undefined;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID || undefined;
      if (!category_uuid) {
        fastify.log.error("Missing SERVICEM8_CATEGORY_UUID for create-job");
        return reply.status(500).send({
          ok: false,
          error: "missing_servicem8_category_uuid",
        });
      }

      fastify.log.info(
        {
          queue_uuid,
          category_uuid,
          mobile: mask(normalizedMobile),
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
        category_uuid,
      });

      const job_uuid = jobCreate.recordUuid;

      await sm8.postJson("/jobcontact.json", {
        job_uuid,
        type: "Job Contact",
        first: firstName,
        last: lastName,
        mobile: normalizedMobile,
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
      let sms_failure_reason: string | null = null;
      let sms_message: string | null = null;
      let availability: { available: boolean; window: string; message: string } | null = null;
      let window_code: string | null = null;
      let window_label: string | null = null;

      const availabilityWindow = computeAvailabilityWindow({
        urgency,
        name: firstName,
      });
      sms_message = availabilityWindow.sms_template;
      window_code = availabilityWindow.window_code;
      window_label = availabilityWindow.window_label;

      if (urgency === "today") {
        availability = getAvailabilityForToday();
      }

      if (urgency === "emergency" && fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: "⚠️ EMERGENCY job created",
        });
      }

      if (generated_job_id && sms_message) {
        try {
          await sendServiceM8Sms({
            companyUuid: vendorUuid,
            toMobile: normalizedMobile,
            message: sms_message.replace("{job_number}", String(generated_job_id)),
            regardingJobUuid: job_uuid,
          });
          sms_sent = true;
        } catch (err: any) {
          sms_failure_reason = err?.status ? `ServiceM8 SMS failed (${err.status})` : "ServiceM8 SMS failed";
        }
      } else if (!generated_job_id) {
        sms_failure_reason = "SMS not sent: missing generated_job_id";
      } else if (!sms_message) {
        sms_failure_reason = "SMS not sent: unknown urgency";
      }

      if (window_code && window_label && fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📅 Proposed window: ${window_label} (${window_code}) (auto)`,
        });
      }

      if (!sms_sent && sms_failure_reason && fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `⚠️ SMS confirmation failed: ${sms_failure_reason}`,
        });
      }

      return reply.send({
        ok: true,
        job_uuid,
        generated_job_id,
        sms_sent,
        window_code,
        window_label,
        availability,
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
