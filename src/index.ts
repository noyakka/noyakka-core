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
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { weekday, hour, minute, year, month, day };
};

const getBrisbaneDateString = (date: Date) => {
  const { year, month, day } = getBrisbaneDateParts(date);
  return `${year}-${month}-${day}`;
};

const parseTimeToMinutes = (time: string) => {
  const [h, m] = time.split(":").map((part) => Number(part));
  return h * 60 + m;
};

const addDays = (date: Date, days: number) => {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const isWeekendInBrisbane = (date: Date) => {
  const { weekday } = getBrisbaneDateParts(date);
  return weekday === "Sat" || weekday === "Sun";
};

const getNextBusinessDay = (date: Date) => {
  let next = addDays(date, 1);
  while (isWeekendInBrisbane(next)) {
    next = addDays(next, 1);
  }
  return next;
};

const formatWindowLabel = (date: Date, window: "MORNING" | "ARVO") => {
  const today = getBrisbaneDateString(new Date());
  const target = getBrisbaneDateString(date);
  const tomorrow = getBrisbaneDateString(addDays(new Date(), 1));
  const windowText = window === "MORNING" ? "morning (8–12)" : "arvo (1–4pm)";

  if (target === today) {
    return `Today ${windowText}`;
  }
  if (target === tomorrow) {
    return `Tomorrow ${windowText}`;
  }
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
  return `${formatter.format(date)} ${windowText}`;
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

const getBusinessConfig = async (vendorUuid: string) => {
  return prisma.businessConfig.upsert({
    where: { servicem8_vendor_uuid: vendorUuid },
    create: {
      servicem8_vendor_uuid: vendorUuid,
      business_name: "Noyakka",
    },
    update: {},
  });
};

const expireHolds = async (vendorUuid: string, now: Date) => {
  await prisma.windowHold.updateMany({
    where: {
      servicem8_vendor_uuid: vendorUuid,
      status: "PENDING",
      expires_at: { lt: now },
    },
    data: { status: "EXPIRED" },
  });
};

const checkCapacity = async (input: {
  vendorUuid: string;
  date: string;
  window: "MORNING" | "ARVO";
  now: Date;
}) => {
  const config = await getBusinessConfig(input.vendorUuid);
  const today = getBrisbaneDateString(input.now);

  const capacityRow = await prisma.windowCapacity.upsert({
    where: {
      servicem8_vendor_uuid_date_window: {
        servicem8_vendor_uuid: input.vendorUuid,
        date: input.date,
        window: input.window,
      },
    },
    create: {
      servicem8_vendor_uuid: input.vendorUuid,
      date: input.date,
      window: input.window,
      capacity_max: config.capacity_per_window,
    },
    update: {
      capacity_max: config.capacity_per_window,
    },
  });

  const holdsPending = await prisma.windowHold.count({
    where: {
      servicem8_vendor_uuid: input.vendorUuid,
      date: input.date,
      window: input.window,
      status: "PENDING",
      expires_at: { gt: input.now },
    },
  });

  const holdsConfirmed = await prisma.windowHold.count({
    where: {
      servicem8_vendor_uuid: input.vendorUuid,
      date: input.date,
      window: input.window,
      status: "CONFIRMED",
    },
  });

  const reserve = input.date === today ? config.emergency_reserve : 0;
  const available = Math.max(
    0,
    capacityRow.capacity_max - holdsPending - holdsConfirmed - reserve
  );

  await prisma.windowCapacity.update({
    where: { id: capacityRow.id },
    data: {
      holds_count: holdsPending,
      confirmed_count: holdsConfirmed,
    },
  });

  return { available, capacity_max: capacityRow.capacity_max };
};

const createHold = async (input: {
  vendorUuid: string;
  jobUuid: string;
  mobile: string;
  date: string;
  window: "MORNING" | "ARVO";
  expiresAt: Date;
}) => {
  return prisma.windowHold.create({
    data: {
      servicem8_vendor_uuid: input.vendorUuid,
      job_uuid: input.jobUuid,
      customer_mobile: input.mobile,
      date: input.date,
      window: input.window,
      status: "PENDING",
      expires_at: input.expiresAt,
    },
  });
};

const getAvailabilityOptions = async (input: {
  vendorUuid: string;
  urgency: string;
  preferredWindow?: string;
  now: Date;
}) => {
  const config = await getBusinessConfig(input.vendorUuid);
  await expireHolds(input.vendorUuid, input.now);

  const preferred =
    input.preferredWindow === "morning" || input.preferredWindow === "arvo"
      ? input.preferredWindow
      : "any";

  if (input.urgency === "emergency") {
    return { type: "emergency", requires_callback: true, options: [] as any[] };
  }

  if (input.urgency === "quote_only") {
    return { type: "quote_only", requires_callback: false, options: [] as any[] };
  }

  const { hour, minute } = getBrisbaneDateParts(input.now);
  const nowMinutes = hour * 60 + minute;
  const cutoffMinutes = parseTimeToMinutes(config.cutoff_time);
  const allowToday = nowMinutes < cutoffMinutes;

  const options: Array<{ date: string; window: string; code: string; label: string }> = [];
  const addOptionIfAvailable = async (date: Date, window: "MORNING" | "ARVO") => {
    const dateStr = getBrisbaneDateString(date);
    const capacity = await checkCapacity({
      vendorUuid: input.vendorUuid,
      date: dateStr,
      window,
      now: input.now,
    });
    if (capacity.available > 0) {
      const label = formatWindowLabel(date, window);
      options.push({
        date: dateStr,
        window,
        code: `${dateStr}_${window}`,
        label,
      });
    }
  };

  if (input.urgency === "today") {
    let startDate = input.now;
    if (!allowToday) {
      startDate = getNextBusinessDay(startDate);
    } else if (isWeekendInBrisbane(startDate)) {
      startDate = getNextBusinessDay(startDate);
    }

    const isSameDay = getBrisbaneDateString(startDate) === getBrisbaneDateString(input.now);
    if (isSameDay && nowMinutes < 10 * 60 + 30 && (preferred === "morning" || preferred === "any")) {
      await addOptionIfAvailable(startDate, "MORNING");
    }
    if (preferred === "arvo" || preferred === "any") {
      await addOptionIfAvailable(startDate, "ARVO");
    }

    if (options.length === 0) {
      const tomorrow = getNextBusinessDay(startDate);
      if (preferred === "morning" || preferred === "any") {
        await addOptionIfAvailable(tomorrow, "MORNING");
      }
      if (options.length === 0 && (preferred === "arvo" || preferred === "any")) {
        await addOptionIfAvailable(tomorrow, "ARVO");
      }
    }

    return { type: "today", requires_callback: false, options };
  }

  if (input.urgency === "this_week") {
    let cursor = input.now;
    let daysScanned = 0;
    const dayOptions = new Set<string>();

    while (daysScanned < 7 && dayOptions.size < 3) {
      if (!isWeekendInBrisbane(cursor)) {
        const dateStr = getBrisbaneDateString(cursor);
        const beforeCount = dayOptions.size;
        if (preferred === "morning" || preferred === "any") {
          await addOptionIfAvailable(cursor, "MORNING");
        }
        if (preferred === "arvo" || preferred === "any") {
          await addOptionIfAvailable(cursor, "ARVO");
        }
        if (options.some((opt) => opt.date === dateStr)) {
          dayOptions.add(dateStr);
        }
        if (dayOptions.size > beforeCount) {
          // keep
        }
      }
      cursor = addDays(cursor, 1);
      daysScanned += 1;
    }

    return { type: "this_week", requires_callback: false, options };
  }

  return { type: "unknown", requires_callback: false, options: [] as any[] };
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
    const vendorUuid = body?.servicem8_vendor_uuid ?? fastify.config.SERVICEM8_VENDOR_UUID;
    if (!vendorUuid) {
      return reply.status(400).send({ ok: false, error: "missing_servicem8_vendor_uuid" });
    }
    const urgency = body?.urgency;
    if (!urgency) {
      return reply.status(400).send({ ok: false, error: "missing_urgency" });
    }

    const config = await getBusinessConfig(vendorUuid);
    const name = body?.name || "there";
    const optionsResult = await getAvailabilityOptions({
      vendorUuid,
      urgency,
      preferredWindow: body?.preferred_window,
      now: body?.now_local ? new Date(body.now_local) : new Date(),
    });

    if (optionsResult.options.length > 0) {
      const option = optionsResult.options[0];
      return reply.send({
        ok: true,
        window_code: option.code,
        window_label: option.label,
        sms_template: `G’day ${name} — we can attend ${option.label}. Reply YES to confirm or NO for the next slot. – ${config.business_name}`,
      });
    }

    if (urgency === "emergency") {
      return reply.send({
        ok: true,
        window_code: "emergency",
        window_label: "Urgent callback",
        sms_template: `EMERGENCY: G’day ${name} — we’ve logged this as urgent. A technician will call within 15 minutes. – ${config.business_name}`,
      });
    }

    if (urgency === "quote_only") {
      return reply.send({
        ok: true,
        window_code: "quote_only",
        window_label: "Quote only",
        sms_template: `G’day ${name} — we’ve got your request and will send a quote. – ${config.business_name}`,
      });
    }

    return reply.send({
      ok: true,
      window_code: "no_options",
      window_label: "No slots available",
      sms_template: `G’day ${name} — we’ll be in touch to arrange a time. – ${config.business_name}`,
    });
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
      const config = await getBusinessConfig(vendorUuid);
      const message = `G’day ${customer_first_name} — we can attend ${window_label}. Reply YES to confirm or NO for the next slot. – ${config.business_name}`;
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

  fastify.post("/vapi/get-availability-options", {
    schema: {
      body: {
        type: "object",
        required: ["urgency"],
        properties: {
          servicem8_vendor_uuid: { type: "string" },
          urgency: { type: "string" },
          preferred_window: { type: "string" },
          now_iso: { type: "string" },
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
    const urgency = body?.urgency;
    if (!urgency) {
      return reply.status(400).send({ ok: false, error: "missing_urgency" });
    }

    const result = await getAvailabilityOptions({
      vendorUuid,
      urgency,
      preferredWindow: body?.preferred_window,
      now: body?.now_iso ? new Date(body.now_iso) : new Date(),
    });

    return reply.send({
      ok: true,
      type: result.type,
      requires_callback: result.requires_callback,
      options: result.options,
    });
  });

  fastify.post("/vapi/book-window", {
    schema: {
      body: {
        type: "object",
        required: ["servicem8_vendor_uuid", "job_uuid", "customer_first_name", "to_mobile", "selected_code"],
        properties: {
          servicem8_vendor_uuid: { type: "string" },
          job_uuid: { type: "string" },
          customer_first_name: { type: "string" },
          to_mobile: { type: "string" },
          selected_code: { type: "string" },
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

    const { job_uuid, customer_first_name, to_mobile, selected_code } = body || {};
    if (!job_uuid || !customer_first_name || !to_mobile || !selected_code) {
      return reply.status(400).send({ ok: false, error: "tool_payload_empty" });
    }

    const normalizedMobile = normalizeMobile(to_mobile);
    if (!normalizedMobile) {
      return reply.status(400).send({ ok: false, error: "invalid_mobile" });
    }

    const [dateStr, windowStr] = String(selected_code).split("_");
    if (!dateStr || (windowStr !== "MORNING" && windowStr !== "ARVO")) {
      return reply.status(400).send({ ok: false, error: "invalid_window_code" });
    }

    const now = new Date();
    await expireHolds(vendorUuid, now);
    const capacity = await checkCapacity({
      vendorUuid,
      date: dateStr,
      window: windowStr,
      now,
    });
    if (capacity.available <= 0) {
      return reply.status(409).send({ ok: false, error: "no_capacity" });
    }

    const config = await getBusinessConfig(vendorUuid);
    const expiresAt = new Date(now.getTime() + config.holds_ttl_minutes * 60 * 1000);
    const hold = await createHold({
      vendorUuid,
      jobUuid: job_uuid,
      mobile: normalizedMobile,
      date: dateStr,
      window: windowStr,
      expiresAt,
    });

    const label = formatWindowLabel(new Date(`${dateStr}T00:00:00+10:00`), windowStr);

    const sm8 = await getServiceM8Client(vendorUuid);
    if (fastify.config.SERVICEM8_STAFF_UUID) {
      await sm8.postJson("/jobactivity.json", {
        job_uuid,
        staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
        type: "note",
        note: `📅 Proposed window: ${label} (hold ${hold.id}, expires ${expiresAt.toISOString()})`,
      });
    }

    const message = `G’day ${customer_first_name} — we’ve pencilled you in for ${label}. Reply YES to confirm or NO for the next slot. – ${config.business_name}`;
    await sendServiceM8Sms({
      companyUuid: vendorUuid,
      toMobile: normalizedMobile,
      message,
      regardingJobUuid: job_uuid,
    });

    return reply.send({ ok: true, hold_id: hold.id, sms_sent: true, label });
  });

  fastify.post("/sms/inbound", async (request, reply) => {
    const body = extractVapiArgs(request.body);
    const fromMobile = body?.from_mobile;
    const text = String(body?.body || "").trim().toUpperCase();
    if (!fromMobile || !text) {
      return reply.status(400).send({ ok: false, error: "tool_payload_empty" });
    }

    const normalizedMobile = normalizeMobile(fromMobile);
    if (!normalizedMobile) {
      return reply.status(400).send({ ok: false, error: "invalid_mobile" });
    }

    const now = new Date();
    const hold = await prisma.windowHold.findFirst({
      where: {
        customer_mobile: normalizedMobile,
        status: "PENDING",
        expires_at: { gt: now },
      },
      orderBy: { created_at: "desc" },
    });

    if (!hold) {
      return reply.send({ ok: true, message: "no_pending_hold" });
    }

    const sm8 = await getServiceM8Client(hold.servicem8_vendor_uuid);
    if (text.startsWith("YES")) {
      await prisma.windowHold.update({
        where: { id: hold.id },
        data: { status: "CONFIRMED", confirmed_at: now },
      });
      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid: hold.job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: "✅ Window confirmed",
        });
      }
      return reply.send({ ok: true, status: "confirmed" });
    }

    if (text.startsWith("NO")) {
      await prisma.windowHold.update({
        where: { id: hold.id },
        data: { status: "DECLINED" },
      });
      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid: hold.job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: "❌ Window declined",
        });
      }
      return reply.send({ ok: true, status: "declined" });
    }

    return reply.send({ ok: true, status: "ignored" });
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

      if (urgency === "emergency") {
        sms_message = `G’day ${firstName} — we’ve logged your urgent job. A technician will call within 15 minutes.`;
        if (fastify.config.SERVICEM8_STAFF_UUID) {
          await sm8.postJson("/jobactivity.json", {
            job_uuid,
            staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
            type: "note",
            note: "⚠️ EMERGENCY job created (callback within 15 mins)",
          });
        }
      } else if (urgency === "quote_only") {
        sms_message = `G’day ${firstName} — we’ve got your request and will send a quote.`;
      } else {
        sms_message = `G’day ${firstName} — we’ve logged your job. We’ll confirm a time shortly.`;
      }

      if (sms_message) {
        try {
          await sendServiceM8Sms({
            companyUuid: vendorUuid,
            toMobile: normalizedMobile,
            message: sms_message,
            regardingJobUuid: job_uuid,
          });
          sms_sent = true;
        } catch (err: any) {
          sms_failure_reason = err?.status ? `ServiceM8 SMS failed (${err.status})` : "ServiceM8 SMS failed";
        }
      } else if (!sms_message) {
        sms_failure_reason = "SMS not sent: unknown urgency";
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
