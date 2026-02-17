import { getServiceM8Client } from "../lib/servicem8-oauth";
import { getRiskFeatureConfig } from "../config/riskFeature";
import { measureDistance } from "./distance";
import { detectRiskFlags } from "./risk";
import { appendJobRiskNote } from "../integrations/servicem8/notes";
import { sendTradieDecisionSMS } from "./tradieNotify";

const toStr = (value: unknown) => (typeof value === "string" ? value : "");

const extractSuburb = (address: string) => {
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length >= 2 ? parts[parts.length - 2] : parts[0] || "";
};

const pickCustomerContact = (contacts: Array<Record<string, unknown>>) => {
  const customer = contacts.find((contact) => {
    const type = toStr(contact.type).toLowerCase();
    return type.includes("job") || type.includes("contact") || type.includes("customer");
  });
  return customer ?? contacts[0] ?? null;
};

const resolveStaffPhone = async (
  sm8: Awaited<ReturnType<typeof getServiceM8Client>>,
  staffUuid: string
) => {
  try {
    const staffRes = await sm8.getJson(`/staff/${staffUuid}.json`);
    const staff = (staffRes?.data ?? {}) as Record<string, unknown>;
    return (
      toStr(staff.mobile) ||
      toStr(staff.phone) ||
      toStr(staff.phone_mobile) ||
      toStr(staff.contact_mobile)
    );
  } catch {
    return "";
  }
};

export const postBookingRiskEnrichment = async (input: {
  request_id: string;
  vendor_uuid: string;
  job_uuid: string;
  allocation_uuid: string;
  window: "morning" | "arvo";
  date: string;
  staff_uuid?: string;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
    error: (meta: unknown, message?: string) => void;
  };
}) => {
  const feature = getRiskFeatureConfig();
  if (!feature.distanceEnabled && !feature.smsEnabled) {
    return;
  }

  const sm8 = await getServiceM8Client(input.vendor_uuid);
  const jobRes = await sm8.getJson(`/job/${input.job_uuid}.json`);
  const job = (jobRes?.data ?? {}) as Record<string, unknown>;
  const jobAddress = toStr(job.job_address);
  const jobDescription = toStr(job.job_description);
  const generatedJobId = toStr(job.generated_job_id || job.job_number || "");

  const contactsRes = await sm8.getJson(`/jobcontact.json?job_uuid=${encodeURIComponent(input.job_uuid)}`);
  const contacts = Array.isArray(contactsRes?.data) ? (contactsRes.data as Array<Record<string, unknown>>) : [];
  const customer = pickCustomerContact(contacts);
  const customerMobile = customer ? toStr(customer.mobile) : "";
  const customerName = customer ? toStr(customer.first || customer.name) : "";

  let distanceKm: number | undefined;
  let distanceBand: "LOCAL" | "MEDIUM" | "FAR" | undefined;
  if (feature.distanceEnabled && feature.businessBaseAddress && feature.googleMapsApiKey && jobAddress) {
    try {
      const distance = await measureDistance({
        originAddress: feature.businessBaseAddress,
        destinationAddress: jobAddress,
        provider: feature.mapsProvider,
        apiKey: feature.googleMapsApiKey,
        thresholds: { mediumKm: feature.distanceMediumKm, farKm: feature.distanceFarKm },
      });
      distanceKm = distance.distanceKm;
      distanceBand = distance.band;
    } catch (err: any) {
      input.logger.warn(
        {
          request_id: input.request_id,
          job_uuid: input.job_uuid,
          error: err?.message,
        },
        "Distance enrichment failed"
      );
    }
  }

  const risk = detectRiskFlags({
    jobDescription,
    smallJobKeywords: feature.smallJobKeywords,
  });
  const flags = [...risk.flags];
  if (distanceBand === "FAR") {
    flags.push("FAR_TRAVEL");
  } else if (distanceBand === "MEDIUM") {
    flags.push("MEDIUM_TRAVEL");
  }

  const keywordText = risk.matchedKeywords.length > 0 ? risk.matchedKeywords.join(", ") : "none";
  const note = [
    `⚠️ Noyakka Risk Flags: ${flags.length > 0 ? flags.join(", ") : "NONE"}`,
    distanceKm !== undefined
      ? `📍 Distance: ${distanceKm.toFixed(1)}km (${distanceBand || "LOCAL"}) from base`
      : "📍 Distance: not calculated",
    `🔧 Detected: '${jobDescription || "n/a"}' (small-job keyword: ${keywordText})`,
    "👉 Suggested: confirm min call-out before finalising",
  ].join("\n");

  if (!feature.riskEnrichDryRun) {
    await appendJobRiskNote({
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      allocation_uuid: input.allocation_uuid,
      noteText: note,
      staff_uuid: input.staff_uuid,
    });
  }

  const tradiePhone = input.staff_uuid ? await resolveStaffPhone(sm8, input.staff_uuid) : "";
  if (feature.smsEnabled && tradiePhone && customerMobile) {
    await sendTradieDecisionSMS({
      vendor_uuid: input.vendor_uuid,
      tradiePhone,
      customerPhone: customerMobile,
      customerName,
      suburb: extractSuburb(jobAddress),
      dateWindow: `${input.date} ${input.window}`,
      flags,
      distanceKm,
      band: distanceBand,
      job_uuid: input.job_uuid,
      allocation_uuid: input.allocation_uuid,
      staff_uuid: input.staff_uuid,
      enabled: feature.smsEnabled,
      dryRun: feature.riskEnrichDryRun,
      logger: input.logger,
    });
  }

  input.logger.info(
    {
      request_id: input.request_id,
      job_uuid: input.job_uuid,
      generated_job_id: generatedJobId,
      flags,
      distance_km: distanceKm,
      distance_band: distanceBand,
      dry_run: feature.riskEnrichDryRun,
      distance_enabled: feature.distanceEnabled,
      sms_enabled: feature.smsEnabled,
    },
    "Post-booking risk enrichment completed"
  );
};
