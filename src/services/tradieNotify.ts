import prisma from "../lib/prisma";
import { sendServiceM8Sms } from "../lib/servicem8-sms";
import { appendJobRiskNote } from "../integrations/servicem8/notes";

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

export const buildDecisionTemplates = (input: {
  customerFirstName?: string;
  distanceBand: string;
  distanceKm?: number;
}) => {
  const firstName = input.customerFirstName?.trim() || "there";
  const distanceText =
    typeof input.distanceKm === "number"
      ? ` (${input.distanceKm.toFixed(1)}km ${input.distanceBand})`
      : "";
  return {
    a: `Hi ${firstName}, thanks for booking with us. Just confirming our minimum call-out applies for this visit${distanceText}. Reply YES to proceed and we will lock it in.`,
    b: `Hi ${firstName}, thanks for the enquiry. We are unable to service this booking window due to scheduling/travel constraints. We can offer another time if you'd like.`,
  };
};

export const sendTradieDecisionSMS = async (input: {
  vendor_uuid: string;
  tradiePhone: string;
  customerPhone: string;
  customerName?: string;
  suburb?: string;
  dateWindow: string;
  flags: string[];
  distanceKm?: number;
  band?: string;
  job_uuid: string;
  allocation_uuid?: string;
  staff_uuid?: string;
  enabled: boolean;
  dryRun: boolean;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
  };
}) => {
  const tradieMobile = normalizeMobile(input.tradiePhone);
  const customerMobile = normalizeMobile(input.customerPhone);
  if (!tradieMobile || !customerMobile) {
    input.logger.warn(
      {
        job_uuid: input.job_uuid,
        tradie_mobile_valid: Boolean(tradieMobile),
        customer_mobile_valid: Boolean(customerMobile),
      },
      "Skipping tradie notify due to invalid mobile"
    );
    return { ok: false, reason: "invalid_mobile" as const };
  }

  const templates = buildDecisionTemplates({
    customerFirstName: input.customerName,
    distanceBand: input.band || "LOCAL",
    distanceKm: input.distanceKm,
  });

  const prettyFlags = input.flags.length > 0 ? input.flags.join(", ") : "NONE";
  const summary = `New booking needs decision.\nFlags: ${prettyFlags}\nReply:\nA = Send min call-out confirmation to customer\nB = Decline (scheduling/travel)\nJob: ${input.job_uuid} / ${input.suburb || "unknown suburb"} / ${input.dateWindow}`;

  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);
  await prisma.pendingDecision.upsert({
    where: { job_uuid: input.job_uuid },
    create: {
      job_uuid: input.job_uuid,
      allocation_uuid: input.allocation_uuid,
      servicem8_vendor_uuid: input.vendor_uuid,
      customer_mobile: customerMobile,
      tradie_mobile: tradieMobile,
      flags_json: JSON.stringify(input.flags),
      distance_km: input.distanceKm ?? null,
      distance_band: input.band ?? null,
      template_a: templates.a,
      template_b: templates.b,
      expires_at: expiresAt,
    },
    update: {
      allocation_uuid: input.allocation_uuid,
      customer_mobile: customerMobile,
      tradie_mobile: tradieMobile,
      flags_json: JSON.stringify(input.flags),
      distance_km: input.distanceKm ?? null,
      distance_band: input.band ?? null,
      template_a: templates.a,
      template_b: templates.b,
      expires_at: expiresAt,
      resolved_at: null,
      resolved_action: null,
    },
  });

  if (!input.enabled || input.dryRun) {
    input.logger.info(
      {
        job_uuid: input.job_uuid,
        tradie_mobile: tradieMobile,
        sms_enabled: input.enabled,
        dry_run: input.dryRun,
      },
      "Tradie decision SMS skipped (disabled/dry-run)"
    );
    return { ok: true, skipped: true as const };
  }

  await sendServiceM8Sms({
    companyUuid: input.vendor_uuid,
    toMobile: tradieMobile,
    message: summary,
    regardingJobUuid: input.job_uuid,
  });
  return { ok: true, skipped: false as const };
};

export const handleTradieDecisionReply = async (input: {
  fromMobile: string;
  body: string;
  smsEnabled: boolean;
  dryRun: boolean;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
  };
}) => {
  const from = normalizeMobile(input.fromMobile || "");
  if (!from) {
    return { ok: false, error: "invalid_mobile" as const };
  }

  const now = new Date();
  const pending = await prisma.pendingDecision.findFirst({
    where: {
      tradie_mobile: from,
      resolved_at: null,
      expires_at: { gt: now },
    },
    orderBy: { created_at: "desc" },
  });
  if (!pending) {
    return { ok: true, message: "no_pending_decision" as const };
  }

  const text = String(input.body || "").trim().toUpperCase();
  const action = text.startsWith("A") ? "A" : text.startsWith("B") ? "B" : null;
  if (!action) {
    return { ok: true, message: "ignored" as const };
  }

  const template = action === "A" ? pending.template_a : pending.template_b;
  if (input.smsEnabled && !input.dryRun) {
    await sendServiceM8Sms({
      companyUuid: pending.servicem8_vendor_uuid,
      toMobile: pending.customer_mobile,
      message: template,
      regardingJobUuid: pending.job_uuid,
    });
  }

  await appendJobRiskNote({
    vendor_uuid: pending.servicem8_vendor_uuid,
    job_uuid: pending.job_uuid,
    allocation_uuid: pending.allocation_uuid ?? undefined,
    noteText: `📩 Customer sent template ${action} at ${new Date().toISOString()}`,
  });

  await prisma.pendingDecision.update({
    where: { id: pending.id },
    data: {
      resolved_action: action,
      resolved_at: new Date(),
    },
  });

  input.logger.info(
    {
      job_uuid: pending.job_uuid,
      action,
      dry_run: input.dryRun,
      sms_enabled: input.smsEnabled,
    },
    "Tradie decision processed"
  );
  return { ok: true, action };
};
