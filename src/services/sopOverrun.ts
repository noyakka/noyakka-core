import prisma from "../lib/prisma";
import { getServiceM8Client } from "../lib/servicem8-oauth";
import { sendServiceM8Sms } from "../lib/servicem8-sms";
import { logOpsEvent } from "../lib/opsEvents";

type ServiceM8Allocation = {
  uuid?: string;
  job_uuid?: string;
  staff_uuid?: string;
  allocation_date?: string;
  start_time?: string;
  end_time?: string;
  completion_timestamp?: string;
  active?: number | string;
};

type SmsType = "DELAY_SMS_SENT" | "MAJOR_DELAY_ALERT_SENT" | "ETA_30MIN_SENT";

const isTruthyFlag = (value: string | undefined, fallback: boolean) => {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
};

const parseBrisbaneDateTime = (datePart: string, timePart: string) => {
  return new Date(`${datePart}T${timePart}:00+10:00`);
};

export const parseServiceM8DateTime = (raw: string | undefined | null) => {
  if (!raw) {
    return null;
  }
  const value = String(raw).trim();
  if (!value || value.startsWith("0000-00-00")) {
    return null;
  }
  if (value.includes("T")) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [datePart, timePart = "00:00:00"] = value.split(" ");
  const [hh = "00", mm = "00"] = timePart.split(":");
  const parsed = parseBrisbaneDateTime(datePart, `${hh}:${mm}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toStartTime = (allocation: ServiceM8Allocation) => {
  if (allocation.start_time) {
    return allocation.start_time.slice(0, 5);
  }
  return "08:00";
};

const toEndTime = (allocation: ServiceM8Allocation) => {
  if (allocation.end_time) {
    return allocation.end_time.slice(0, 5);
  }
  return "12:00";
};

export const getEstimatedEnd = (allocation: ServiceM8Allocation) => {
  const date = allocation.allocation_date?.slice(0, 10);
  if (!date) {
    return null;
  }
  return parseBrisbaneDateTime(date, toEndTime(allocation));
};

export const getEstimatedStart = (allocation: ServiceM8Allocation) => {
  const date = allocation.allocation_date?.slice(0, 10);
  if (!date) {
    return null;
  }
  return parseBrisbaneDateTime(date, toStartTime(allocation));
};

const getBusinessName = async (vendor_uuid: string) => {
  const cfg = await prisma.vendorConfig.findUnique({
    where: { servicem8_vendor_uuid: vendor_uuid },
    select: { business_name: true },
  });
  return cfg?.business_name || "Noyakka";
};

const getJobCustomerContact = async (input: {
  sm8: Awaited<ReturnType<typeof getServiceM8Client>>;
  job_uuid: string;
}) => {
  try {
    const res = await input.sm8.getJson(`/jobcontact.json?job_uuid=${encodeURIComponent(input.job_uuid)}`);
    const contacts = Array.isArray(res?.data) ? (res.data as Array<Record<string, unknown>>) : [];
    const preferred =
      contacts.find((contact) => String(contact.type || "").toLowerCase().includes("job")) ??
      contacts[0];
    const name = String(preferred?.first || preferred?.name || "there");
    const mobile = String(preferred?.mobile || "").trim();
    return { name, mobile };
  } catch {
    return { name: "there", mobile: "" };
  }
};

const formatTime = (date: Date) => {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
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

export const findNextAllocation = (allocations: ServiceM8Allocation[], current: ServiceM8Allocation) => {
  const currentStart = getEstimatedStart(current);
  if (!currentStart || !current.staff_uuid) {
    return null;
  }
  const dateKey = current.allocation_date?.slice(0, 10);
  const candidates = allocations
    .filter((item) => item.uuid && item.staff_uuid === current.staff_uuid)
    .filter((item) => item.allocation_date?.slice(0, 10) === dateKey)
    .filter((item) => item.uuid !== current.uuid)
    .filter((item) => !parseServiceM8DateTime(item.completion_timestamp))
    .map((item) => ({ item, start: getEstimatedStart(item) }))
    .filter((item) => item.start && item.start.getTime() > currentStart.getTime())
    .sort((a, b) => (a.start!.getTime() - b.start!.getTime()));
  return candidates[0]?.item ?? null;
};

const brisbaneDate = (value: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);

const brisbaneClock = (value: Date) =>
  new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(value)
    .replace(/\s/g, "");

const claimSmsEvent = async (input: {
  source_allocation_uuid: string;
  target_allocation_uuid?: string;
  target_job_uuid: string;
  sms_type: SmsType;
  now: Date;
}) => {
  try {
    await prisma.overrunSmsEvent.create({
      data: {
        source_allocation_uuid: input.source_allocation_uuid,
        target_allocation_uuid: input.target_allocation_uuid || null,
        target_job_uuid: input.target_job_uuid,
        sms_type: input.sms_type,
        last_sms_sent_at: input.now,
      },
    });
    return true;
  } catch (err: any) {
    if (err?.code === "P2002") {
      return false;
    }
    throw err;
  }
};

const releaseSmsClaim = async (input: {
  source_allocation_uuid: string;
  target_job_uuid: string;
  sms_type: SmsType;
}) => {
  try {
    await prisma.overrunSmsEvent.delete({
      where: {
        source_allocation_uuid_target_job_uuid_sms_type: {
          source_allocation_uuid: input.source_allocation_uuid,
          target_job_uuid: input.target_job_uuid,
          sms_type: input.sms_type,
        },
      },
    });
  } catch {
    // no-op
  }
};

const appendJobNote = async (input: {
  sm8: Awaited<ReturnType<typeof getServiceM8Client>>;
  job_uuid: string;
  note: string;
}) => {
  await input.sm8.postJson("/jobactivity.json", {
    job_uuid: input.job_uuid,
    type: "note",
    note: input.note,
  });
};

export const runJobOverrunMonitor = async (input: {
  vendor_uuid: string;
  dispatcher_mobile?: string;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
  };
}) => {
  const enabled = isTruthyFlag(process.env.OVERRUN_PROTECTION_ENABLED, false);
  if (!enabled) {
    return { ok: true, skipped: true };
  }

  const graceMinutes = Number(process.env.OVERRUN_GRACE_MINUTES || "15");
  const majorDelayMinutes = Number(process.env.OVERRUN_MAJOR_DELAY_MINUTES || "90");
  const now = new Date();
  const sm8 = await getServiceM8Client(input.vendor_uuid);
  const today = brisbaneDate(now);

  const allocRes = await sm8.getJson(`/joballocation.json?allocation_date=${encodeURIComponent(today)}`);
  const allocationsRaw = Array.isArray(allocRes?.data) ? allocRes.data : [];
  const allocations = allocationsRaw as ServiceM8Allocation[];
  const businessName = await getBusinessName(input.vendor_uuid);

  let overrunEvents = 0;
  let totalDelayMinutes = 0;
  let smsSentCount = 0;

  for (const allocation of allocations) {
    const allocationUuid = allocation.uuid;
    if (!allocationUuid || !allocation.job_uuid) {
      continue;
    }
    if (String(allocation.active ?? "1") !== "1") {
      continue;
    }

    const completedAt = parseServiceM8DateTime(allocation.completion_timestamp);
    const estimatedEnd = getEstimatedEnd(allocation);
    if (!estimatedEnd) {
      continue;
    }

    if (!completedAt) {
      const overrunBy = Math.floor((now.getTime() - estimatedEnd.getTime()) / 60000);
      if (overrunBy > graceMinutes) {
        overrunEvents += 1;
        totalDelayMinutes += overrunBy;
        logOpsEvent(input.logger, "OVERRUN_DETECTED", {
          vendor_uuid: input.vendor_uuid,
          allocation_uuid: allocationUuid,
          job_uuid: allocation.job_uuid,
          delay_minutes: overrunBy,
        });
        await prisma.overrunMonitorState.upsert({
          where: { allocation_uuid: allocationUuid },
          create: {
            allocation_uuid: allocationUuid,
            job_uuid: allocation.job_uuid,
            staff_uuid: allocation.staff_uuid || null,
            allocation_date: allocation.allocation_date?.slice(0, 10) || null,
            overrun_detected_at: now,
            delay_minutes: overrunBy,
          },
          update: {
            overrun_detected_at: now,
            delay_minutes: overrunBy,
          },
        });

        const nextAllocation = findNextAllocation(allocations, allocation);
        if (nextAllocation?.uuid && nextAllocation.job_uuid) {
          const delayClaimed = await claimSmsEvent({
            source_allocation_uuid: allocationUuid,
            target_allocation_uuid: nextAllocation.uuid,
            target_job_uuid: nextAllocation.job_uuid,
            sms_type: "DELAY_SMS_SENT",
            now,
          });
          if (delayClaimed) {
            const originalStart = getEstimatedStart(nextAllocation);
            if (originalStart) {
              const newEta = new Date(originalStart.getTime() + overrunBy * 60_000);
              const customer = await getJobCustomerContact({ sm8, job_uuid: nextAllocation.job_uuid });
              const customerMobile = normalizeMobile(customer.mobile);
              if (customerMobile) {
                const message = `[${businessName}]\n\nHi ${customer.name},\n\nYour technician is running slightly behind due to a complex job.\n\nUpdated arrival estimate: approximately ${formatTime(newEta)}.\n\nThanks for your patience — we'll message again when 30 mins away.`;
                try {
                  await sendServiceM8Sms({
                    companyUuid: input.vendor_uuid,
                    toMobile: customerMobile,
                    message,
                    regardingJobUuid: nextAllocation.job_uuid,
                  });
                } catch (err) {
                  await releaseSmsClaim({
                    source_allocation_uuid: allocationUuid,
                    target_job_uuid: nextAllocation.job_uuid,
                    sms_type: "DELAY_SMS_SENT",
                  });
                  throw err;
                }
                smsSentCount += 1;
                logOpsEvent(input.logger, "DELAY_SMS_SENT", {
                  vendor_uuid: input.vendor_uuid,
                  source_allocation_uuid: allocationUuid,
                  target_allocation_uuid: nextAllocation.uuid,
                  target_job_uuid: nextAllocation.job_uuid,
                  delay_minutes: overrunBy,
                  new_eta: newEta.toISOString(),
                });
                await prisma.overrunMonitorState.upsert({
                  where: { allocation_uuid: nextAllocation.uuid },
                  create: {
                    allocation_uuid: nextAllocation.uuid,
                    job_uuid: nextAllocation.job_uuid,
                    staff_uuid: nextAllocation.staff_uuid || null,
                    allocation_date: nextAllocation.allocation_date?.slice(0, 10) || null,
                    delay_sms_sent_at: now,
                  },
                  update: {
                    delay_sms_sent_at: now,
                  },
                });
                await appendJobNote({
                  sm8,
                  job_uuid: nextAllocation.job_uuid,
                  note: `⏱️ Delay update sent to customer at ${now.toISOString()} (new ETA ~${formatTime(newEta)})`,
                });
              }
            }
          }
        }

        const sourceState = await prisma.overrunMonitorState.findUnique({
          where: { allocation_uuid: allocationUuid },
        });
        const dispatcherMobile = normalizeMobile(input.dispatcher_mobile || "");
        if (overrunBy > majorDelayMinutes && dispatcherMobile && !sourceState?.major_alert_sent_at) {
          const majorClaimed = await claimSmsEvent({
            source_allocation_uuid: allocationUuid,
            target_job_uuid: allocation.job_uuid,
            sms_type: "MAJOR_DELAY_ALERT_SENT",
            now,
          });
          if (majorClaimed) {
            const message = "⚠️ Major delay detected — manual intervention recommended.";
            try {
              await sendServiceM8Sms({
                companyUuid: input.vendor_uuid,
                toMobile: dispatcherMobile,
                message,
                regardingJobUuid: allocation.job_uuid,
              });
            } catch (err) {
              await releaseSmsClaim({
                source_allocation_uuid: allocationUuid,
                target_job_uuid: allocation.job_uuid,
                sms_type: "MAJOR_DELAY_ALERT_SENT",
              });
              throw err;
            }
            smsSentCount += 1;
            logOpsEvent(input.logger, "MAJOR_DELAY_ALERT_SENT", {
              vendor_uuid: input.vendor_uuid,
              source_allocation_uuid: allocationUuid,
              job_uuid: allocation.job_uuid,
              delay_minutes: overrunBy,
            });
            await prisma.overrunMonitorState.update({
              where: { allocation_uuid: allocationUuid },
              data: { major_alert_sent_at: now },
            });
          }
        }
      }
      continue;
    }

    // 30-minute away message for next job after completion.
    const nextAfterComplete = findNextAllocation(allocations, allocation);
    if (!nextAfterComplete?.uuid || !nextAfterComplete.job_uuid) {
      continue;
    }
    const nextStart = getEstimatedStart(nextAfterComplete);
    if (!nextStart) {
      continue;
    }
    const minutesUntilNext = Math.floor((nextStart.getTime() - now.getTime()) / 60000);
    if (minutesUntilNext <= 0 || minutesUntilNext > 30) {
      continue;
    }
    const etaClaimed = await claimSmsEvent({
      source_allocation_uuid: allocationUuid,
      target_allocation_uuid: nextAfterComplete.uuid,
      target_job_uuid: nextAfterComplete.job_uuid,
      sms_type: "ETA_30MIN_SENT",
      now,
    });
    if (!etaClaimed) {
      continue;
    }
    const customer = await getJobCustomerContact({ sm8, job_uuid: nextAfterComplete.job_uuid });
    const customerMobile = normalizeMobile(customer.mobile);
    if (!customerMobile) {
      await releaseSmsClaim({
        source_allocation_uuid: allocationUuid,
        target_job_uuid: nextAfterComplete.job_uuid,
        sms_type: "ETA_30MIN_SENT",
      });
      continue;
    }
    try {
      await sendServiceM8Sms({
        companyUuid: input.vendor_uuid,
        toMobile: customerMobile,
        message: `Hi ${customer.name}, your technician is 30 minutes away.`,
        regardingJobUuid: nextAfterComplete.job_uuid,
      });
    } catch (err) {
      await releaseSmsClaim({
        source_allocation_uuid: allocationUuid,
        target_job_uuid: nextAfterComplete.job_uuid,
        sms_type: "ETA_30MIN_SENT",
      });
      throw err;
    }
    smsSentCount += 1;
    logOpsEvent(input.logger, "ETA_30MIN_SENT", {
      vendor_uuid: input.vendor_uuid,
      source_allocation_uuid: allocationUuid,
      target_allocation_uuid: nextAfterComplete.uuid,
      target_job_uuid: nextAfterComplete.job_uuid,
    });
    await prisma.overrunMonitorState.upsert({
      where: { allocation_uuid: nextAfterComplete.uuid },
      create: {
        allocation_uuid: nextAfterComplete.uuid,
        job_uuid: nextAfterComplete.job_uuid,
        staff_uuid: nextAfterComplete.staff_uuid || null,
        allocation_date: nextAfterComplete.allocation_date?.slice(0, 10) || null,
        thirty_away_sms_sent_at: now,
      },
      update: { thirty_away_sms_sent_at: now },
    });
    await appendJobNote({
      sm8,
      job_uuid: nextAfterComplete.job_uuid,
      note: `🚐 30-minute-away SMS sent at ${now.toISOString()}`,
    });
  }

  const averageDelay = overrunEvents > 0 ? totalDelayMinutes / overrunEvents : 0;
  const states = await prisma.overrunMonitorState.findMany({
    where: { overrun_detected_at: { not: null } },
    select: { delay_minutes: true, overrun_detected_at: true, delay_sms_sent_at: true },
  });
  const etaAccuracyRate =
    states.length > 0
      ? states.filter((state) => state.delay_sms_sent_at !== null).length / states.length
      : 1;

  input.logger.info(
    {
      overrun_events: overrunEvents,
      average_delay_minutes: Number(averageDelay.toFixed(1)),
      eta_accuracy_rate: Number(etaAccuracyRate.toFixed(3)),
      sms_sent_count: smsSentCount,
    },
    "SOP overrun monitor metrics"
  );

  return {
    ok: true,
    overrun_events: overrunEvents,
    average_delay_minutes: Number(averageDelay.toFixed(1)),
    eta_accuracy_rate: Number(etaAccuracyRate.toFixed(3)),
    sms_sent_count: smsSentCount,
  };
};

export const simulateOverrunForJob = async (input: {
  vendor_uuid: string;
  job_uuid: string;
  minutesOverdue: number;
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
  };
}) => {
  const sm8 = await getServiceM8Client(input.vendor_uuid);
  const res = await sm8.getJson(`/joballocation.json?job_uuid=${encodeURIComponent(input.job_uuid)}`);
  const allocations = Array.isArray(res?.data) ? (res.data as ServiceM8Allocation[]) : [];
  const current =
    allocations
      .filter((a) => a.uuid)
      .sort((a, b) => String(b.allocation_date || "").localeCompare(String(a.allocation_date || "")))[0] ?? null;

  if (!current?.uuid) {
    return { ok: false, error: "allocation_not_found" as const };
  }

  const now = new Date();
  const backdatedEnd = new Date(now.getTime() - input.minutesOverdue * 60_000);
  const allocation_date = brisbaneDate(backdatedEnd);
  const end_time = brisbaneClock(backdatedEnd);

  await sm8.putJson(`/joballocation/${current.uuid}.json`, {
    allocation_date,
    end_time,
  });

  input.logger.info(
    {
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      allocation_uuid: current.uuid,
      simulated_end_time: `${allocation_date} ${end_time}`,
      minutes_overdue: input.minutesOverdue,
    },
    "SOP simulate overrun patched allocation"
  );

  const result = await runJobOverrunMonitor({
    vendor_uuid: input.vendor_uuid,
    dispatcher_mobile: process.env.DISPATCHER_MOBILE,
    logger: input.logger,
  });

  return {
    ok: true,
    allocation_uuid: current.uuid,
    simulated_end_time: `${allocation_date} ${end_time}`,
    monitor_result: result,
  };
};
