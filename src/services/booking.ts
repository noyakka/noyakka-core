import prisma from "../lib/prisma";
import { getServiceM8Client } from "../lib/servicem8-oauth";
import { sendServiceM8Sms } from "../lib/servicem8-sms";
import { finishToolRunFailure, finishToolRunSuccess, getOrStartToolRun } from "../lib/idempotency";
import { push as pushBookingError } from "../lib/debug/bookingErrors";
import { postBookingRiskEnrichment } from "./postBookingRiskEnrichment";
import { runCapacityEngine } from "../lib/scheduling/capacityEngine";
import {
  fetchAllocationsForDate,
  getSchedulingV2Config,
  isSchedulingV2Enabled,
  mapServiceM8Allocations,
  mapServiceM8Staff,
} from "../lib/scheduling/serviceM8Scheduling";
import { logOpsEvent } from "../lib/opsEvents";

type Window = "morning" | "arvo";

type BookWindowInput = {
  request_id: string;
  endpoint: string;
  vendor_uuid: string;
  call_id: string;
  job_uuid: string;
  date: string;
  window: Window;
  allocation_window_uuid?: string;
  sms?: {
    to_mobile: string;
    message: string;
    job_uuid?: string;
  };
  record_booking?: boolean;
  env: {
    business_tz?: string;
    queue_uuid?: string;
    staff_uuid?: string;
  };
  logger: {
    info: (meta: unknown, message?: string) => void;
    warn: (meta: unknown, message?: string) => void;
    error: (meta: unknown, message?: string) => void;
  };
};

type BookWindowResult =
  | {
      ok: true;
      allocation_uuid: string;
      date: string;
      window: Window;
      label: string;
      sms_sent?: boolean;
      sms_error?: string;
    }
  | {
      ok: false;
      error_code: string;
      message: string;
      debug_ref?: string;
      servicem8_status?: number;
      servicem8_body?: unknown;
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

const redactAllocationPayloadForLog = (payload: Record<string, unknown>) => {
  // Keep operational fields only; no customer PII is sent in this payload.
  return {
    job_uuid: payload.job_uuid,
    allocation_window_uuid: payload.allocation_window_uuid,
    allocation_date: payload.allocation_date,
    start_date: payload.start_date,
    start_time: payload.start_time,
    end_time: payload.end_time,
    queue_uuid: payload.queue_uuid,
    staff_uuid: payload.staff_uuid,
  };
};

const getBrisbaneDateParts = (date: Date, businessTz: string) => {
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: businessTz,
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
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { year, month, day, hour, minute };
};

const getBrisbaneDateString = (date: Date, businessTz: string) => {
  const { year, month, day } = getBrisbaneDateParts(date, businessTz);
  return `${year}-${month}-${day}`;
};

const formatShortWindowLabel = (date: Date, window: Window, businessTz: string) => {
  const today = getBrisbaneDateString(new Date(), businessTz);
  const target = getBrisbaneDateString(date, businessTz);
  const windowText = window === "morning" ? "morning (8–12pm)" : "arvo (1–4pm)";
  if (target === today) {
    return `Today ${windowText}`;
  }
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: businessTz,
    weekday: "short",
  });
  return `${formatter.format(date)} ${windowText}`;
};

const parseTimeToMinutes = (time: string) => {
  const [h, m] = time.split(":").map((part) => Number(part));
  return h * 60 + m;
};

const parseWindowTime = (value: unknown) => {
  if (!value) {
    return null;
  }
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }
  return hours * 60 + minutes;
};

const classifyAllocationWindow = (window: any) => {
  const name = String(window?.name || window?.title || "").toLowerCase();
  const start =
    parseWindowTime(window?.start_time) ??
    parseWindowTime(window?.start) ??
    parseWindowTime(window?.start_time_24) ??
    parseWindowTime(window?.start_time_local);
  const end =
    parseWindowTime(window?.end_time) ??
    parseWindowTime(window?.end) ??
    parseWindowTime(window?.end_time_24) ??
    parseWindowTime(window?.end_time_local);

  const isMorningByName = name.includes("morning") || name.includes("am");
  const isArvoByName = name.includes("afternoon") || name.includes("arvo") || name.includes("pm");
  const isMorningByTime =
    start !== null &&
    end !== null &&
    start >= 7 * 60 &&
    start <= 9 * 60 &&
    end >= 11 * 60 &&
    end <= 13 * 60;
  const isArvoByTime =
    start !== null &&
    end !== null &&
    start >= 12 * 60 &&
    start <= 15 * 60 &&
    end >= 15 * 60 &&
    end <= 18 * 60;

  return {
    isMorning: isMorningByName || isMorningByTime,
    isArvo: isArvoByName || isArvoByTime,
  };
};

const refreshAllocationWindows = async (vendor_uuid: string) => {
  const sm8 = await getServiceM8Client(vendor_uuid);
  const res = await sm8.getJson("/allocationwindow.json");
  const windows = Array.isArray(res.data) ? res.data : res.data?.data ?? [];

  let morningWindowUuid: string | null = null;
  let arvoWindowUuid: string | null = null;

  for (const window of windows) {
    const { isMorning, isArvo } = classifyAllocationWindow(window);
    if (!morningWindowUuid && isMorning) {
      morningWindowUuid = window.uuid || window.window_uuid || window.allocation_window_uuid || null;
    }
    if (!arvoWindowUuid && isArvo) {
      arvoWindowUuid = window.uuid || window.window_uuid || window.allocation_window_uuid || null;
    }
  }

  await prisma.allocationWindowMap.upsert({
    where: { servicem8_vendor_uuid: vendor_uuid },
    create: {
      servicem8_vendor_uuid: vendor_uuid,
      morning_window_uuid: morningWindowUuid,
      arvo_window_uuid: arvoWindowUuid,
      raw_windows_json: JSON.stringify(windows),
    },
    update: {
      morning_window_uuid: morningWindowUuid,
      arvo_window_uuid: arvoWindowUuid,
      raw_windows_json: JSON.stringify(windows),
    },
  });

  return { morningWindowUuid, arvoWindowUuid, windows };
};

const resolveAllocationWindowUuid = async (
  vendor_uuid: string,
  window: Window,
  preferred?: string
) => {
  if (preferred) {
    return preferred;
  }
  const existing = await prisma.allocationWindowMap.findUnique({
    where: { servicem8_vendor_uuid: vendor_uuid },
  });
  const candidate = window === "morning" ? existing?.morning_window_uuid : existing?.arvo_window_uuid;
  if (candidate) {
    return candidate;
  }
  const refreshed = await refreshAllocationWindows(vendor_uuid);
  return window === "morning" ? refreshed.morningWindowUuid : refreshed.arvoWindowUuid;
};

const getVendorConfig = async (vendor_uuid: string) => {
  return prisma.vendorConfig.upsert({
    where: { servicem8_vendor_uuid: vendor_uuid },
    create: {
      servicem8_vendor_uuid: vendor_uuid,
      business_name: "Noyakka",
      morning_capacity: 6,
      arvo_capacity: 6,
    },
    update: {},
  });
};

const isPastWindow = async (vendor_uuid: string, date: string, window: Window, businessTz: string) => {
  const now = new Date();
  const { hour, minute, year, month, day } = getBrisbaneDateParts(now, businessTz);
  const today = `${year}-${month}-${day}`;
  if (date < today) {
    return true;
  }
  if (date !== today) {
    return false;
  }
  if (window === "morning") {
    return hour >= 12;
  }
  const config = await getVendorConfig(vendor_uuid);
  const cutoffMinutes = parseTimeToMinutes(config.cutoff_today_arvo);
  return hour * 60 + minute >= cutoffMinutes;
};

const classifyServiceM8Error = (status?: number) => {
  if (status === 401) {
    return { error_code: "SERVICEM8_UNAUTH", message: "ServiceM8 unauthorized" };
  }
  if (status === 403) {
    return { error_code: "SERVICEM8_INSUFFICIENT_SCOPE", message: "ServiceM8 insufficient scope" };
  }
  if (status === 422) {
    return { error_code: "SERVICEM8_VALIDATION_ERROR", message: "ServiceM8 validation error" };
  }
  return { error_code: "SERVICEM8_ALLOC_FAILED", message: "ServiceM8 allocation failed" };
};

const resolveStaffUuid = async (
  sm8: Awaited<ReturnType<typeof getServiceM8Client>>,
  input: Pick<BookWindowInput, "request_id" | "vendor_uuid" | "job_uuid" | "env" | "logger">
) => {
  const configuredStaffUuid = input.env.staff_uuid;
  try {
    const staffRes = await sm8.getJson("/staff.json");
    const staffList = Array.isArray(staffRes?.data)
      ? (staffRes.data as Array<Record<string, unknown>>)
      : [];
    const activeStaff = staffList.filter((staff) => {
      const uuid = typeof staff.uuid === "string" ? staff.uuid : "";
      if (!uuid) {
        return false;
      }
      const activeValue = String(staff.active ?? "1");
      return activeValue === "1" || activeValue.toLowerCase() === "true";
    });

    if (configuredStaffUuid) {
      const configuredActive = activeStaff.find((staff) => staff.uuid === configuredStaffUuid);
      if (configuredActive) {
        input.logger.info(
          {
            request_id: input.request_id,
            vendor_uuid: input.vendor_uuid,
            job_uuid: input.job_uuid,
            staff_uuid: configuredStaffUuid,
            staff_resolution: "configured_active",
          },
          "Resolved staff_uuid for allocation"
        );
        return configuredStaffUuid;
      }
    }

    const firstActive = activeStaff.find((staff) => typeof staff.uuid === "string");
    const selected = typeof firstActive?.uuid === "string" ? firstActive.uuid : undefined;
    input.logger.info(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        staff_uuid: selected ?? configuredStaffUuid ?? null,
        staff_resolution: selected ? "first_active_staff" : "configured_fallback",
        active_staff_count: activeStaff.length,
      },
      "Resolved staff_uuid for allocation"
    );
    return selected ?? configuredStaffUuid;
  } catch (err: any) {
    input.logger.warn(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        staff_uuid: configuredStaffUuid ?? null,
        servicem8_status: err?.status,
        servicem8_body: err?.data,
      },
      "Staff lookup failed; using configured staff fallback"
    );
    return configuredStaffUuid;
  }
};

export const bookWindow = async (input: BookWindowInput): Promise<BookWindowResult | { replayResult: any }> => {
  const { run, replayResult } = await getOrStartToolRun(
    input.vendor_uuid,
    input.endpoint,
    input.call_id
  );
  if (replayResult) {
    return { replayResult };
  }

  input.logger.info(
    {
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      call_id: input.call_id,
      job_uuid: input.job_uuid,
      date: input.date,
      window: input.window,
    },
    "Booking start"
  );

  let config = await getVendorConfig(input.vendor_uuid);
  const schedulingV2 = isSchedulingV2Enabled();
  if (input.record_booking && !schedulingV2) {
    const maxCapacity = input.window === "morning" ? config.morning_capacity : config.arvo_capacity;
    const row = await prisma.windowCapacity.findUnique({
      where: {
        servicem8_vendor_uuid_date_window: {
          servicem8_vendor_uuid: input.vendor_uuid,
          date: input.date,
          window: input.window,
        },
      },
    });
    const currentBooked = row?.booked_count ?? 0;
    const currentMax = row?.max_capacity ?? maxCapacity;
    if (currentMax - currentBooked - config.emergency_reserve <= 0) {
      const payload = {
        ok: false as const,
        error_code: "NO_CAPACITY",
        message: "No capacity available",
      };
      await finishToolRunFailure(run.id, "NO_CAPACITY");
      return payload;
    }
  }

  const businessTz = input.env.business_tz || "Australia/Brisbane";
  const pastWindow = await isPastWindow(input.vendor_uuid, input.date, input.window, businessTz);
  if (pastWindow) {
    const payload = {
      ok: false as const,
      error_code: "PAST_WINDOW",
      message: "Requested booking is in the past",
    };
    await finishToolRunFailure(run.id, "PAST_WINDOW");
    return payload;
  }

  let allocationWindowUuid = await resolveAllocationWindowUuid(
    input.vendor_uuid,
    input.window,
    input.allocation_window_uuid
  );
  input.logger.info(
    {
      request_id: input.request_id,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      allocation_window_uuid: allocationWindowUuid,
      allocation_date: input.date,
      window: input.window,
    },
    "Booking allocation window resolved"
  );
  if (!allocationWindowUuid) {
    const payload = {
      ok: false as const,
      error_code: "MISSING_ALLOCATION_WINDOW",
      message: "Allocation window not configured",
    };
    await finishToolRunFailure(run.id, "MISSING_ALLOCATION_WINDOW");
    return payload;
  }

  const sm8 = await getServiceM8Client(input.vendor_uuid);
  let allocationUuid: string | null = null;
  let allocationResponse: any = null;
  let queueUuidForAllocation: string | undefined = input.env.queue_uuid;
  let staffUuidForAllocation = await resolveStaffUuid(sm8, input);
  let scheduledStartTime = input.window === "morning" ? "08:00" : "13:00";
  let scheduledEndTime = input.window === "morning" ? "12:00" : "16:00";
  let includeSchedulingStatus = schedulingV2;

  if (schedulingV2) {
    const schedulingConfig = getSchedulingV2Config();
    const staffRes = await sm8.getJson("/staff.json");
    const staff = mapServiceM8Staff(staffRes?.data);
    if (staff.length === 0) {
      const payload = {
        ok: false as const,
        error_code: "NO_CAPACITY",
        message: "No active staff available",
      };
      await finishToolRunFailure(run.id, "NO_CAPACITY");
      return payload;
    }

    const windowMap = await refreshAllocationWindows(input.vendor_uuid);
    const allocationsRaw = await fetchAllocationsForDate({
      sm8,
      date: input.date,
    });
    const allocations = mapServiceM8Allocations({
      allocationsRaw,
      date: input.date,
      morningWindowUuid: windowMap.morningWindowUuid,
      arvoWindowUuid: windowMap.arvoWindowUuid,
    });
    const requestedWindow = input.window === "morning" ? "morning" : "afternoon";
    const decision = runCapacityEngine({
      staff,
      allocations,
      window: requestedWindow,
      job_duration_minutes: schedulingConfig.defaultJobDurationMinutes,
      max_jobs_per_window: schedulingConfig.maxJobsPerWindow,
      buffer_ratio: schedulingConfig.bufferRatio,
    });
    if (decision.window_full || !decision.selected_staff_uuid || !decision.start_time || !decision.end_time) {
      const payload = {
        ok: false as const,
        error_code: "NO_CAPACITY",
        message: "No capacity available",
      };
      await finishToolRunFailure(run.id, "NO_CAPACITY");
      return payload;
    }

    staffUuidForAllocation = decision.selected_staff_uuid;
    scheduledStartTime = decision.start_time;
    scheduledEndTime = decision.end_time;
    const mappedWindowUuid =
      input.window === "morning" ? windowMap.morningWindowUuid : windowMap.arvoWindowUuid;
    if (mappedWindowUuid) {
      allocationWindowUuid = mappedWindowUuid;
    }
    input.logger.info(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        scheduling_v2: true,
        selected_staff_uuid: staffUuidForAllocation,
        start_time: scheduledStartTime,
        end_time: scheduledEndTime,
        staff_usage: decision.staff_usage,
      },
      "Scheduling V2 assignment selected"
    );
  }

  if (!queueUuidForAllocation) {
    try {
      const jobLookup = await sm8.getJson(`/job/${input.job_uuid}.json`);
      const jobData = (jobLookup?.data ?? {}) as Record<string, unknown>;
      const candidate =
        (typeof jobData.queue_uuid === "string" ? jobData.queue_uuid : undefined) ??
        (typeof jobData.job_queue_uuid === "string" ? jobData.job_queue_uuid : undefined);
      if (candidate) {
        queueUuidForAllocation = candidate;
        input.logger.info(
          { request_id: input.request_id, job_uuid: input.job_uuid, queue_uuid: candidate },
          "Resolved queue_uuid from job"
        );
      }
    } catch {
      // If queue lookup fails we'll still attempt allocation; ServiceM8 will return actionable error.
    }
  }

  if (!queueUuidForAllocation) {
    try {
      const queuesRes = await sm8.getJson("/jobqueue.json");
      const queues = Array.isArray(queuesRes?.data) ? (queuesRes.data as Array<Record<string, unknown>>) : [];
      const preferred =
        queues.find((q) => String(q.active ?? "1") === "1" && String(q.requires_assignment ?? "0") !== "1") ??
        queues.find((q) => String(q.active ?? "1") === "1") ??
        queues[0];
      if (preferred && typeof preferred.uuid === "string") {
        queueUuidForAllocation = preferred.uuid;
        input.logger.info(
          { request_id: input.request_id, queue_uuid: queueUuidForAllocation },
          "Resolved queue_uuid from jobqueue list"
        );
      }
    } catch {
      // ignore queue resolution failures
    }
  }

  const attemptCreate = async () => {
    const payloadQueueUuid = schedulingV2
      ? undefined
      : staffUuidForAllocation
        ? undefined
        : queueUuidForAllocation;
    const allocationPayload: Record<string, unknown> = {
      job_uuid: input.job_uuid,
      allocation_window_uuid: allocationWindowUuid,
      // Keep legacy field plus explicit start/end fields for reliability across API behaviors.
      allocation_date: input.date,
      start_date: input.date,
      start_time: scheduledStartTime,
      end_time: scheduledEndTime,
      ...(includeSchedulingStatus ? { status: "scheduled" } : {}),
      ...(payloadQueueUuid ? { queue_uuid: payloadQueueUuid } : {}),
      ...(staffUuidForAllocation ? { staff_uuid: staffUuidForAllocation } : {}),
    };

    input.logger.info(
      {
        request_id: input.request_id,
        job_uuid: input.job_uuid,
        allocation_window_uuid: allocationWindowUuid,
        date: input.date,
        window: input.window,
      },
      `ALLOCATION_ATTEMPT request_id=${input.request_id} job_uuid=${input.job_uuid} allocation_window_uuid=${allocationWindowUuid} date=${input.date} window=${input.window}`
    );
    input.logger.info(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        allocation_window_uuid: allocationWindowUuid,
        allocation_date: input.date,
        queue_uuid: payloadQueueUuid,
        staff_uuid: staffUuidForAllocation,
        allocation_payload: allocationPayload,
        payload: redactAllocationPayloadForLog(allocationPayload),
      },
      "ServiceM8 allocation create attempt"
    );
    allocationResponse = await sm8.postJson("/joballocation.json", allocationPayload);
    input.logger.info(
      {
        request_id: input.request_id,
        job_uuid: input.job_uuid,
        servicem8_status: allocationResponse?.status,
        servicem8_body: allocationResponse?.data,
      },
      "ServiceM8 allocation create response"
    );
    allocationUuid =
      allocationResponse?.recordUuid ??
      allocationResponse?.data?.uuid ??
      allocationResponse?.data?.recordUuid ??
      null;
  };

  try {
    await attemptCreate();
  } catch (err: any) {
    if (schedulingV2 && includeSchedulingStatus && (err?.status === 400 || err?.status === 422)) {
      includeSchedulingStatus = false;
      try {
        await attemptCreate();
      } catch (retryWithoutStatusErr: any) {
        err = retryWithoutStatusErr;
      }
    }

    const errorInfo = classifyServiceM8Error(err?.status);
    input.logger.warn(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        allocation_window_uuid: allocationWindowUuid,
        allocation_date: input.date,
        servicem8_status: err?.status,
        servicem8_body: err?.data,
      },
      "ServiceM8 allocation create failed"
    );

    if (err?.status === 422) {
      const refreshed = await refreshAllocationWindows(input.vendor_uuid);
      allocationWindowUuid =
        input.window === "morning" ? refreshed.morningWindowUuid : refreshed.arvoWindowUuid;
      if (allocationWindowUuid) {
        try {
          await attemptCreate();
        } catch (retryErr: any) {
          const retryInfo = classifyServiceM8Error(retryErr?.status);
          await finishToolRunFailure(run.id, retryInfo.error_code);
          pushBookingError({
            request_id: input.request_id,
            endpoint: input.endpoint,
            vendor_uuid: input.vendor_uuid,
            call_id: input.call_id,
            job_uuid: input.job_uuid,
            date: input.date,
            window: input.window,
            allocation_window_uuid: allocationWindowUuid,
            error_code: retryInfo.error_code,
            message: retryInfo.message,
            servicem8_status: retryErr?.status,
            servicem8_body: retryErr?.data,
          });
          const failurePayload = {
            ok: false,
            error_code: retryInfo.error_code,
            message: retryInfo.message,
            debug_ref: input.request_id,
            servicem8_status: retryErr?.status,
            servicem8_body: retryErr?.data,
          };
          logOpsEvent(input.logger, "BOOKING_FAILED", {
            request_id: input.request_id,
            endpoint: input.endpoint,
            vendor_uuid: input.vendor_uuid,
            job_uuid: input.job_uuid,
            reason: failurePayload.error_code,
          });
          return failurePayload;
        }
      }
    }

    await finishToolRunFailure(run.id, errorInfo.error_code);
    pushBookingError({
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      call_id: input.call_id,
      job_uuid: input.job_uuid,
      date: input.date,
      window: input.window,
      allocation_window_uuid: allocationWindowUuid,
      error_code: errorInfo.error_code,
      message: errorInfo.message,
      servicem8_status: err?.status,
      servicem8_body: err?.data,
    });
    const failurePayload = {
      ok: false,
      error_code: errorInfo.error_code,
      message: errorInfo.message,
      debug_ref: input.request_id,
      servicem8_status: err?.status,
      servicem8_body: err?.data,
    };
    logOpsEvent(input.logger, "BOOKING_FAILED", {
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      reason: failurePayload.error_code,
    });
    return failurePayload;
  }

  if (!allocationUuid) {
    const payload = {
      ok: false as const,
      error_code: "ALLOCATION_MISSING_UUID",
      message: "Allocation did not return a UUID",
      debug_ref: input.request_id,
    };
    await finishToolRunFailure(run.id, "ALLOCATION_MISSING_UUID");
    pushBookingError({
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      call_id: input.call_id,
      job_uuid: input.job_uuid,
      date: input.date,
      window: input.window,
      allocation_window_uuid: allocationWindowUuid,
      error_code: "ALLOCATION_MISSING_UUID",
      message: payload.message,
      servicem8_body: allocationResponse,
    });
    logOpsEvent(input.logger, "BOOKING_FAILED", {
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      reason: payload.error_code,
    });
    return payload;
  }

  // Immediate list verification: ensure allocation is visible for the job.
  try {
    const listRes = await sm8.getJson(`/joballocation.json?job_uuid=${encodeURIComponent(input.job_uuid)}`);
    const list = Array.isArray(listRes?.data) ? listRes.data : [];
    input.logger.info(
      {
        request_id: input.request_id,
        job_uuid: input.job_uuid,
        allocation_count: list.length,
      },
      "ServiceM8 allocation list verification"
    );
    if (list.length === 0) {
      const payload = {
        ok: false as const,
        error_code: "ALLOCATION_VERIFY_FAILED",
        message: "Allocation list verification failed (0 results)",
        debug_ref: input.request_id,
      };
      await finishToolRunFailure(run.id, "ALLOCATION_VERIFY_FAILED");
      pushBookingError({
        request_id: input.request_id,
        endpoint: input.endpoint,
        vendor_uuid: input.vendor_uuid,
        call_id: input.call_id,
        job_uuid: input.job_uuid,
        date: input.date,
        window: input.window,
        allocation_window_uuid: allocationWindowUuid,
        error_code: "ALLOCATION_VERIFY_FAILED",
        message: payload.message,
        servicem8_body: listRes?.data,
      });
      logOpsEvent(input.logger, "BOOKING_FAILED", {
        request_id: input.request_id,
        endpoint: input.endpoint,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        reason: payload.error_code,
      });
      return payload;
    }
  } catch (err: any) {
    input.logger.warn(
      {
        request_id: input.request_id,
        job_uuid: input.job_uuid,
        servicem8_status: err?.status,
        servicem8_body: err?.data,
      },
      "ServiceM8 allocation list verification request failed"
    );
  }

  try {
    await sm8.getJson(`/joballocation/${allocationUuid}.json`);
    input.logger.info(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        allocation_uuid: allocationUuid,
      },
      "ServiceM8 allocation verified"
    );
  } catch (err: any) {
    const payload = {
      ok: false as const,
      error_code: "ALLOCATION_VERIFY_FAILED",
      message: "Allocation verification failed",
      debug_ref: input.request_id,
      servicem8_status: err?.status,
      servicem8_body: err?.data,
    };
    await finishToolRunFailure(run.id, "ALLOCATION_VERIFY_FAILED");
    pushBookingError({
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      call_id: input.call_id,
      job_uuid: input.job_uuid,
      date: input.date,
      window: input.window,
      allocation_window_uuid: allocationWindowUuid,
      error_code: "ALLOCATION_VERIFY_FAILED",
      message: payload.message,
      servicem8_status: err?.status,
      servicem8_body: err?.data,
    });
    logOpsEvent(input.logger, "BOOKING_FAILED", {
      request_id: input.request_id,
      endpoint: input.endpoint,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      reason: payload.error_code,
    });
    return payload;
  }

  if (input.record_booking && !schedulingV2) {
    const maxCapacity = input.window === "morning" ? config.morning_capacity : config.arvo_capacity;
    try {
      await prisma.$transaction(async (tx) => {
        const row = await tx.windowCapacity.findUnique({
          where: {
            servicem8_vendor_uuid_date_window: {
              servicem8_vendor_uuid: input.vendor_uuid,
              date: input.date,
              window: input.window,
            },
          },
        });
        const currentBooked = row?.booked_count ?? 0;
        const currentMax = row?.max_capacity ?? maxCapacity;
        if (currentMax - currentBooked - config.emergency_reserve <= 0) {
          throw new Error("no_capacity");
        }
        await tx.windowCapacity.upsert({
          where: {
            servicem8_vendor_uuid_date_window: {
              servicem8_vendor_uuid: input.vendor_uuid,
              date: input.date,
              window: input.window,
            },
          },
          create: {
            servicem8_vendor_uuid: input.vendor_uuid,
            date: input.date,
            window: input.window,
            max_capacity: maxCapacity,
            booked_count: 1,
          },
          update: {
            max_capacity: maxCapacity,
            booked_count: currentBooked + 1,
          },
        });
        await tx.jobWindowBooking.upsert({
          where: { job_uuid: input.job_uuid },
          create: {
            job_uuid: input.job_uuid,
            servicem8_vendor_uuid: input.vendor_uuid,
            date: input.date,
            window: input.window,
            allocation_uuid: allocationUuid,
            status: "confirmed",
          },
          update: {
            allocation_uuid: allocationUuid,
            date: input.date,
            window: input.window,
            status: "confirmed",
          },
        });
      });
    } catch (err: any) {
      try {
        await sm8.deleteJson(`/joballocation/${allocationUuid}.json`);
      } catch {
        // ignore cleanup failures
      }
      const payload = {
        ok: false as const,
        error_code: "NO_CAPACITY",
        message: "No capacity available",
      };
      await finishToolRunFailure(run.id, "NO_CAPACITY");
      logOpsEvent(input.logger, "BOOKING_FAILED", {
        request_id: input.request_id,
        endpoint: input.endpoint,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        reason: payload.error_code,
      });
      return payload;
    }
  }

  let sms_sent = false;
  let sms_error: string | undefined;
  if (input.sms?.to_mobile && input.sms?.message) {
    const normalizedMobile = normalizeMobile(input.sms.to_mobile);
    if (normalizedMobile) {
      try {
        await sendServiceM8Sms({
          companyUuid: input.vendor_uuid,
          toMobile: normalizedMobile,
          message: input.sms.message,
          regardingJobUuid: input.sms.job_uuid,
        });
        sms_sent = true;
        input.logger.info(
          {
            request_id: input.request_id,
            vendor_uuid: input.vendor_uuid,
            job_uuid: input.job_uuid,
            sms_sent: true,
          },
          "Booking SMS sent"
        );
      } catch (err: any) {
        sms_error = err?.status ? `ServiceM8 SMS failed (${err.status})` : "ServiceM8 SMS failed";
        input.logger.warn(
          {
            request_id: input.request_id,
            vendor_uuid: input.vendor_uuid,
            job_uuid: input.job_uuid,
            sms_sent: false,
            sms_error,
          },
          "Booking SMS failed"
        );
      }
    }
  }

  const label = formatShortWindowLabel(new Date(`${input.date}T00:00:00+10:00`), input.window, businessTz);
  const payload = {
    ok: true as const,
    allocation_uuid: allocationUuid,
    date: input.date,
    window: input.window,
    label,
    ...(input.sms ? { sms_sent } : {}),
    ...(sms_error ? { sms_error } : {}),
  };
  await finishToolRunSuccess(run.id, payload);
  input.logger.info(
    {
      request_id: input.request_id,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      allocation_uuid: allocationUuid,
    },
    "Booking success"
  );
  logOpsEvent(input.logger, "BOOKING_ALLOCATION_CREATED", {
    request_id: input.request_id,
    endpoint: input.endpoint,
    vendor_uuid: input.vendor_uuid,
    job_uuid: input.job_uuid,
    allocation_uuid: allocationUuid,
    date: input.date,
    window: input.window,
  });

  try {
    await postBookingRiskEnrichment({
      request_id: input.request_id,
      vendor_uuid: input.vendor_uuid,
      job_uuid: input.job_uuid,
      allocation_uuid: allocationUuid,
      date: input.date,
      window: input.window,
      staff_uuid: staffUuidForAllocation,
      logger: input.logger,
    });
  } catch (err: any) {
    input.logger.warn(
      {
        request_id: input.request_id,
        vendor_uuid: input.vendor_uuid,
        job_uuid: input.job_uuid,
        allocation_uuid: allocationUuid,
        error: err?.message,
      },
      "Post-booking risk enrichment failed"
    );
  }

  return payload;
};
