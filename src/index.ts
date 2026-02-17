import Fastify from 'fastify';
import { randomUUID } from "crypto";
import cors from '@fastify/cors';
import env from '@fastify/env';
import dotenv from "dotenv";
import { buildCreateLeadHandler } from "./routes/vapi.create-lead";
import { buildSendSmsHandler } from "./routes/vapi.send-sms";
import { registerServiceM8AuthRoutes } from "./routes/auth.servicem8";
import prisma from "./lib/prisma";
import { getServiceM8Client, resolveVendorUuidForApiKey } from "./lib/servicem8-oauth";
import { sendServiceM8Sms } from "./lib/servicem8-sms";
import { extractVapiArgs } from "./lib/vapi/extract";
import { normalizeVapiArgs, normalizeUrgency as normalizeVapiUrgency } from "./lib/vapi/normalize";
import {
  debugListAvailabilityEntries,
  getAvailabilityOptionsForBooking,
  getAvailabilityOptionsForCall,
  saveAvailabilityOptions,
} from "./lib/vapi/availabilityStore";
import {
  vapiBookingBookWindowSchema,
  vapiBookingCancelSchema,
  vapiBookWindowSchema,
  vapiCreateJobSchema,
  vapiLightSchema,
  vapiPingSchema,
  vapiSendBookedSmsSchema,
  vapiSendLoggedSmsSchema,
  vapiSendWindowSmsSchema,
} from "./lib/vapi/validate";
import { list as listVapiRing } from "./lib/debug/vapiRing";
import { list as listBookingErrors, push as pushBookingError } from "./lib/debug/bookingErrors";
import { list as listAvailabilityErrors, push as pushAvailabilityError } from "./lib/debug/availabilityErrors";
import { buildResponsePreview, listToolReceipts, pushToolReceipt } from "./lib/debug/toolReceipts";
import { finishToolRunFailure, finishToolRunSuccess, getOrStartToolRun } from "./lib/idempotency";
import { buildValidationPayload, finalizeVapi, logVapiStart } from "./lib/vapi/runtime";
import { logOpsEvent } from "./lib/opsEvents";
import { bookWindow } from "./services/booking";
import { requireServiceM8Env } from "./lib/env/requireEnv";
import { validateRiskFeatureConfig } from "./config/riskFeature";
import { handleTradieDecisionReply } from "./services/tradieNotify";
import { runCapacityEngine } from "./lib/scheduling/capacityEngine";
import {
  fetchAllocationsForDate,
  getSchedulingV2Config,
  isSchedulingV2Enabled,
  mapServiceM8Allocations,
  mapServiceM8Staff,
} from "./lib/scheduling/serviceM8Scheduling";
import { runProfitInsightForJob } from "./services/profit/insight";
import {
  buildProfitInsightNote,
  parseFinancialEnv,
} from "./services/profit/insight";
import { classifyElectricalJob } from "./services/profit/classifier";
import { estimateProfit } from "./services/profit/estimator";
import { runJobOverrunMonitor, simulateOverrunForJob } from "./services/sopOverrun";

let lastVapiCall: { at: string; body: unknown } | null = null;
const recentCreateJobs = new Map<string, {
  at: number;
  job_uuid: string;
  generated_job_id: string | number | null;
  sms_sent: boolean;
}>();
const recentJobByVendor = new Map<string, { at: number; job_uuid: string }>();
let lastCapacitySeedDate: string | null = null;


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
    timeZone: process.env.BUSINESS_TZ || "Australia/Brisbane",
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

const getNextWeekStart = (date: Date) => {
  let cursor = addDays(date, 1);
  for (let i = 0; i < 14; i += 1) {
    const { weekday } = getBrisbaneDateParts(cursor);
    if (weekday === "Mon") {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }
  return getNextBusinessDay(date);
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

const formatShortWindowLabel = (date: Date, window: "morning" | "arvo") => {
  const today = getBrisbaneDateString(new Date());
  const target = getBrisbaneDateString(date);
  const tomorrow = getBrisbaneDateString(addDays(new Date(), 1));
  const windowText = window === "morning" ? "morning (8–12pm)" : "arvo (1–4pm)";

  if (target === today) {
    return `Today ${windowText}`;
  }
  if (target === tomorrow) {
    return `Tomorrow ${windowText}`;
  }
  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: process.env.BUSINESS_TZ || "Australia/Brisbane",
    weekday: "long",
  });
  return `${formatter.format(date)} ${windowText}`;
};

const optionsToResult = (options: Array<{ label?: string }>) => {
  const top = options
    .slice(0, 3)
    .map((option) => (typeof option.label === "string" ? option.label : ""))
    .filter((label) => label.length > 0);
  if (top.length === 0) {
    return "No available times found.";
  }
  if (top.length === 1) {
    return `We can do ${top[0]}.`;
  }
  if (top.length === 2) {
    return `We can do ${top[0]} or ${top[1]}.`;
  }
  return `We can do ${top[0]}, ${top[1]}, or ${top[2]}.`;
};

const toBookingWindow = (value: unknown): "morning" | "arvo" | undefined => {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "morning") return "morning";
  if (normalized === "arvo" || normalized === "afternoon") return "arvo";
  return undefined;
};

const toPublicWindow = (value: "morning" | "arvo"): "morning" | "afternoon" =>
  value === "morning" ? "morning" : "afternoon";

const trimBookingOptions = (
  options: Array<{ code?: string; label?: string; date?: string; window?: string }>
) =>
  options
    .filter((option) =>
      typeof option.code === "string" &&
      typeof option.label === "string" &&
      typeof option.date === "string" &&
      typeof option.window === "string")
    .map((option) => ({
      code: option.code as string,
      label: option.label as string,
      date: option.date as string,
      window: option.window as string,
    }));

const buildReofferOptionsPayload = (input: {
  vendor_uuid: string;
  call_id: string | undefined;
  job_uuid: string | undefined;
  message: string;
  reason: string;
}) => {
  const stored = getAvailabilityOptionsForBooking({
    vendor_uuid: input.vendor_uuid,
    ...(input.call_id ? { call_id: input.call_id } : {}),
    ...(input.job_uuid ? { job_uuid: input.job_uuid } : {}),
  });
  const options = trimBookingOptions(stored?.options ?? []).slice(0, 3);
  return {
    ok: false,
    error_code: input.reason,
    message: input.message,
    options,
    result:
      options.length > 0
        ? `${input.message} ${optionsToResult(options)} Please pick one of these exact options.`
        : input.message,
  };
};

const normalizeSelectionText = (input: string) =>
  String(input || "")
    .toLowerCase()
    .replace(/\btommorow\b/g, "tomorrow")
    .replace(/[^\w\s-]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCodeLike = (input: string) =>
  String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const resolveSelectedOptionFromStored = (input: {
  selected_code: string;
  storedOptions: Array<{
    code?: string;
    label?: string;
    date?: string;
    window?: string;
    allocation_window_uuid?: string;
    staff_uuid?: string;
    start?: string;
    end?: string;
    start_time?: string;
    end_time?: string;
  }>;
  now: Date;
}) => {
  const options = input.storedOptions;
  const selected = String(input.selected_code || "").trim();
  if (!selected || options.length === 0) {
    return null;
  }

  const exactCode = options.find((option) => option.code === selected);
  if (exactCode) {
    return exactCode;
  }

  const selectedCodeLike = normalizeCodeLike(selected);
  const byCodeLike = options.find((option) => normalizeCodeLike(String(option.code || "")) === selectedCodeLike);
  if (byCodeLike) {
    return byCodeLike;
  }

  const selectedText = normalizeSelectionText(selected);
  const byExactLabel = options.find((option) => normalizeSelectionText(String(option.label || "")) === selectedText);
  if (byExactLabel) {
    return byExactLabel;
  }

  const parsed = parseSelectedWindowCode(selected, input.now);
  if (parsed) {
    const parsedWindow = parsed.window === "MORNING" ? "morning" : "arvo";
    const byParsedDateWindow = options.find(
      (option) =>
        String(option.date || "") === parsed.dateStr &&
        (option.window === "morning" || option.window === "arvo") &&
        option.window === parsedWindow
    );
    if (byParsedDateWindow) {
      return byParsedDateWindow;
    }
  }

  const wantsMorning = /\bmorning\b/.test(selectedText);
  const wantsArvo = /\barvo\b|\bafternoon\b/.test(selectedText);
  const hints: string[] = [];
  if (/\btoday\b/.test(selectedText)) hints.push("today");
  if (/\btomorrow\b/.test(selectedText)) hints.push("tomorrow");
  const weekdayHints = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  for (const hint of weekdayHints) {
    if (selectedText.includes(hint)) {
      hints.push(hint);
    }
  }

  const fuzzy = options.filter((option) => {
    const label = normalizeSelectionText(String(option.label || ""));
    const optionWindow = toBookingWindow(option.window);
    if (wantsMorning && optionWindow !== "morning") return false;
    if (wantsArvo && optionWindow !== "arvo") return false;
    if (hints.length > 0 && !hints.some((hint) => label.includes(hint))) return false;
    return label.includes(selectedText) || selectedText.includes(label) || hints.some((hint) => label.includes(hint));
  });
  if (fuzzy.length === 1) {
    return fuzzy[0];
  }

  return null;
};

const pushRouteBookingError = (input: {
  request_id: string;
  endpoint: string;
  vendor_uuid?: string;
  call_id?: string;
  job_uuid?: string;
  date?: string;
  window?: string;
  allocation_window_uuid?: string;
  error_code: string;
  message?: string;
  valid_codes?: string[];
  servicem8_status?: number;
  servicem8_body?: unknown;
}) => {
  pushBookingError({
    request_id: input.request_id,
    endpoint: input.endpoint,
    ...(input.vendor_uuid ? { vendor_uuid: input.vendor_uuid } : {}),
    ...(input.call_id ? { call_id: input.call_id } : {}),
    ...(input.job_uuid ? { job_uuid: input.job_uuid } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.window ? { window: input.window } : {}),
    ...(input.allocation_window_uuid ? { allocation_window_uuid: input.allocation_window_uuid } : {}),
    error_code: input.error_code,
    ...(input.message ? { message: input.message } : {}),
    ...(input.valid_codes ? { valid_codes: input.valid_codes } : {}),
    ...(typeof input.servicem8_status === "number" ? { servicem8_status: input.servicem8_status } : {}),
    ...(input.servicem8_body !== undefined ? { servicem8_body: input.servicem8_body } : {}),
  });
};

const getRecentJobUuidForVendor = (vendor_uuid: string) => {
  const row = recentJobByVendor.get(vendor_uuid);
  if (!row) {
    return undefined;
  }
  if (Date.now() - row.at > 30 * 60 * 1000) {
    recentJobByVendor.delete(vendor_uuid);
    return undefined;
  }
  return row.job_uuid;
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

const maskValue = (value: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

const normalizeUrgency = (input: string | null | undefined) => {
  if (!input) {
    return null;
  }
  const value = String(input).trim().toLowerCase().replace(/\s+/g, "_");
  if (value.startsWith("emergency") || value.startsWith("urgent")) {
    return "emergency";
  }
  if (value === "today" || value === "todays" || value === "same_day") {
    return "today";
  }
  if (value === "next_week" || value === "nextweek") {
    return "next_week";
  }
  if (value.includes("week")) {
    return "this_week";
  }
  if (value === "quote_only" || value === "quote") {
    return "quote_only";
  }
  return null;
};

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const buildLoggedSms = (input: {
  first_name: string;
  job_number: string;
  job_address: string;
  business_name: string;
}) => {
  return `G'day ${input.first_name} — we’ve logged your job.\n\nJob #${input.job_number}\n📍 ${input.job_address}\n\nWe’ll confirm timing shortly.\n\nCheers,\n${input.business_name}`;
};

const buildBookedSms = (input: {
  first_name: string;
  date_label: string;
  window_label: string;
  time_range: string;
  job_number: string;
  job_address: string;
  business_name: string;
}) => {
  return `G'day ${input.first_name} — you're booked for ${input.date_label} ${input.window_label} (${input.time_range}).\n\nJob #${input.job_number}\n📍 ${input.job_address}\n\nYour tech will text you on the day with their arrival time.\n\nQuestions? Reply to this text.\n\nCheers,\n${input.business_name}`;
};

const formatBrisbaneDateTime = (dateStr: string, time: string) => {
  const offset = "+10:00";
  return `${dateStr}T${time}:00${offset}`;
};

const formatBrisbaneLocalDateTime = (dateStr: string, time: string) => {
  return `${dateStr} ${time}:00`;
};

const getNextWeekdayDate = (start: Date, targetWeekday: string) => {
  const targetMap: Record<string, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  const targetIndex = targetMap[targetWeekday.toLowerCase()];
  if (targetIndex === undefined) {
    return start;
  }

  let cursor = start;
  for (let i = 0; i < 7; i += 1) {
    const { weekday } = getBrisbaneDateParts(cursor);
    const currentIndex = targetMap[weekday.toLowerCase()];
    if (currentIndex === targetIndex) {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }
  return start;
};

const parseSelectedWindowCode = (input: string, now: Date) => {
  const normalized = String(input).trim().toUpperCase().replace(/\s+/g, "_");
  const parts = normalized.split("_");
  if (parts.length < 2) {
    return null;
  }
  const token = parts[0];
  const windowToken = parts[1];
  const window = windowToken === "MORNING" || windowToken === "ARVO" ? windowToken : null;
  if (!window) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    return { dateStr: token, window };
  }

  if (token === "TODAY") {
    return { dateStr: getBrisbaneDateString(now), window };
  }
  if (token === "TOMORROW") {
    return { dateStr: getBrisbaneDateString(addDays(now, 1)), window };
  }

  const weekdayToken = token.toLowerCase();
  const weekdayDate = getNextWeekdayDate(now, weekdayToken);
  return { dateStr: getBrisbaneDateString(weekdayDate), window };
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

const getVendorConfig = async (vendorUuid: string) => {
  return prisma.vendorConfig.upsert({
    where: { servicem8_vendor_uuid: vendorUuid },
    create: {
      servicem8_vendor_uuid: vendorUuid,
      business_name: "Noyakka",
      morning_capacity: 6,
      arvo_capacity: 6,
    },
    update: {},
  });
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

const getAllocationWindowMap = async (vendorUuid: string) => {
  const sm8 = await getServiceM8Client(vendorUuid);
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
    where: { servicem8_vendor_uuid: vendorUuid },
    create: {
      servicem8_vendor_uuid: vendorUuid,
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

const ensureWindowCapacity = async (input: {
  vendorUuid: string;
  date: string;
  window: "morning" | "arvo";
  maxCapacity: number;
}) => {
  return prisma.windowCapacity.upsert({
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
      max_capacity: input.maxCapacity,
    },
    update: {
      max_capacity: input.maxCapacity,
    },
  });
};

const getAvailableCapacity = async (input: {
  vendorUuid: string;
  date: string;
  window: "morning" | "arvo";
  maxCapacity: number;
  emergencyReserve: number;
}) => {
  const row = await ensureWindowCapacity({
    vendorUuid: input.vendorUuid,
    date: input.date,
    window: input.window,
    maxCapacity: input.maxCapacity,
  });
  const available = Math.max(0, row.max_capacity - row.booked_count - input.emergencyReserve);
  return { available, row };
};

const getEmergencyCapacity = async (input: {
  vendorUuid: string;
  date: string;
  window: "morning" | "arvo";
  maxCapacity: number;
}) => {
  const row = await ensureWindowCapacity({
    vendorUuid: input.vendorUuid,
    date: input.date,
    window: input.window,
    maxCapacity: input.maxCapacity,
  });
  const available = Math.max(0, row.max_capacity - row.booked_count);
  return { available, row };
};

const hasSchedulingV2Capacity = async (input: {
  sm8: { getJson: (path: string) => Promise<{ data: unknown }> };
  date: string;
  window: "morning" | "arvo";
  morningWindowUuid?: string | null;
  arvoWindowUuid?: string | null;
  staff: Array<{ uuid: string; work_start?: string; work_end?: string }>;
  allocationsByDate: Map<string, unknown[]>;
}) => {
  const schedulingConfig = getSchedulingV2Config();
  const cached = input.allocationsByDate.get(input.date);
  const allocationsRaw =
    cached ??
    (await fetchAllocationsForDate({
      sm8: input.sm8,
      date: input.date,
    }));
  if (!cached) {
    input.allocationsByDate.set(input.date, allocationsRaw);
  }

  const allocations = mapServiceM8Allocations({
    allocationsRaw,
    date: input.date,
    morningWindowUuid: input.morningWindowUuid,
    arvoWindowUuid: input.arvoWindowUuid,
  });
  const result = runCapacityEngine({
    staff: input.staff,
    allocations,
    window: input.window === "morning" ? "morning" : "afternoon",
    job_duration_minutes: schedulingConfig.defaultJobDurationMinutes,
    max_jobs_per_window: schedulingConfig.maxJobsPerWindow,
    buffer_ratio: schedulingConfig.bufferRatio,
  });
  return !result.window_full;
};

const getWorkingDays = (config: { working_days: unknown }) => {
  if (Array.isArray(config.working_days)) {
    return config.working_days.map((item) => String(item).toLowerCase());
  }
  if (typeof config.working_days === "string") {
    try {
      const parsed = JSON.parse(config.working_days);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).toLowerCase());
      }
    } catch {
      // fall back
    }
  }
  return ["mon", "tue", "wed", "thu", "fri"];
};

const getNextWorkingDay = (date: Date, workingDays: string[]) => {
  let cursor = date;
  for (let i = 0; i < 14; i += 1) {
    const weekday = getBrisbaneDateParts(cursor).weekday.toLowerCase();
    if (workingDays.includes(weekday)) {
      return cursor;
    }
    cursor = addDays(cursor, 1);
  }
  return date;
};

const autoBookEmergency = async (input: {
  vendorUuid: string;
  jobUuid: string;
  firstName: string;
  toMobile: string;
  jobAddress: string;
  jobNumber: string;
}) => {
  const config = await getVendorConfig(input.vendorUuid);
  const workingDays = getWorkingDays(config);
  const { morningWindowUuid, arvoWindowUuid, windows } = await getAllocationWindowMap(input.vendorUuid);
  if (!morningWindowUuid || !arvoWindowUuid) {
    return { ok: false, error: "missing_allocation_windows", windows };
  }

  const now = new Date();
  const { hour, minute } = getBrisbaneDateParts(now);
  const nowMinutes = hour * 60 + minute;
  const cutoffMinutes = parseTimeToMinutes(config.cutoff_today_arvo);

  const todayDate = getBrisbaneDateString(now);
  let targetDate = todayDate;
  let targetWindow: "morning" | "arvo" = nowMinutes < 12 * 60 ? "morning" : "arvo";
  if (nowMinutes >= cutoffMinutes) {
    const nextWorking = getNextWorkingDay(addDays(now, 1), workingDays);
    targetDate = getBrisbaneDateString(nextWorking);
    targetWindow = "morning";
  }

  const tryBook = async (dateStr: string, window: "morning" | "arvo") => {
    const maxCapacity = window === "morning" ? config.morning_capacity : config.arvo_capacity;
    const capacity = await getEmergencyCapacity({
      vendorUuid: input.vendorUuid,
      date: dateStr,
      window,
      maxCapacity,
    });
    if (capacity.available <= 0) {
      return null;
    }

    const allocationWindowUuid = window === "morning" ? morningWindowUuid : arvoWindowUuid;
    const sm8 = await getServiceM8Client(input.vendorUuid);
    const allocation = await sm8.postJson("/joballocation.json", {
      job_uuid: input.jobUuid,
      allocation_date: dateStr,
      allocation_window_uuid: allocationWindowUuid,
    });
    const allocationUuid = allocation.recordUuid ?? null;
    if (!allocationUuid) {
      return null;
    }

    await prisma.$transaction(async (tx) => {
      await tx.windowCapacity.upsert({
        where: {
          servicem8_vendor_uuid_date_window: {
            servicem8_vendor_uuid: input.vendorUuid,
            date: dateStr,
            window,
          },
        },
        create: {
          servicem8_vendor_uuid: input.vendorUuid,
          date: dateStr,
          window,
          max_capacity: maxCapacity,
          booked_count: 1,
        },
        update: {
          max_capacity: maxCapacity,
          booked_count: capacity.row.booked_count + 1,
        },
      });
      await tx.jobWindowBooking.create({
        data: {
          job_uuid: input.jobUuid,
          servicem8_vendor_uuid: input.vendorUuid,
          date: dateStr,
          window,
          allocation_uuid: allocationUuid,
          status: "confirmed",
        },
      });
    });

    const label = formatShortWindowLabel(new Date(`${dateStr}T00:00:00+10:00`), window);
    const windowLabel = window === "morning" ? "morning" : "arvo";
    const timeRange = window === "morning" ? "8–12pm" : "1–4pm";
    const smsMessage = buildBookedSms({
      first_name: input.firstName,
      date_label: label.replace(/ (morning|arvo).*/, "").trim(),
      window_label: windowLabel,
      time_range: timeRange,
      job_number: input.jobNumber,
      job_address: input.jobAddress,
      business_name: config.business_name,
    });

    let smsSent = false;
    try {
      await sendServiceM8Sms({
        companyUuid: input.vendorUuid,
        toMobile: input.toMobile,
        message: smsMessage,
        regardingJobUuid: input.jobUuid,
      });
      smsSent = true;
    } catch {
      // best effort
    }

    return {
      allocation_uuid: allocationUuid,
      date: dateStr,
      window,
      label,
      sms_sent: smsSent,
    };
  };

  let booking = await tryBook(targetDate, targetWindow);
  if (!booking && targetDate === todayDate) {
    const alternate = targetWindow === "morning" ? "arvo" : "morning";
    booking = await tryBook(targetDate, alternate);
  }
  if (!booking) {
    const nextWorking = getNextWorkingDay(addDays(now, 1), workingDays);
    booking = await tryBook(getBrisbaneDateString(nextWorking), "morning");
  }

  if (!booking) {
    return { ok: false, error: "no_capacity" };
  }

  return { ok: true, booking };
};

const seedCapacityForAllVendors = async () => {
  const vendors = await prisma.serviceM8Connection.findMany({
    select: { vendor_uuid: true },
  });

  const now = new Date();
  for (const vendor of vendors) {
    const config = await getVendorConfig(vendor.vendor_uuid);
    const workingDays = getWorkingDays(config);

    let cursor = now;
    for (let i = 0; i < 14; i += 1) {
      const weekday = getBrisbaneDateParts(cursor).weekday.toLowerCase();
      if (workingDays.includes(weekday)) {
        const dateStr = getBrisbaneDateString(cursor);
        await ensureWindowCapacity({
          vendorUuid: vendor.vendor_uuid,
          date: dateStr,
          window: "morning",
          maxCapacity: config.morning_capacity,
        });
        await ensureWindowCapacity({
          vendorUuid: vendor.vendor_uuid,
          date: dateStr,
          window: "arvo",
          maxCapacity: config.arvo_capacity,
        });
      }
      cursor = addDays(cursor, 1);
    }
  }
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
      max_capacity: config.capacity_per_window,
    },
    update: {
      max_capacity: config.capacity_per_window,
    },
  });

  const reserve = input.date === today ? config.emergency_reserve : 0;
  const available = Math.max(0, capacityRow.max_capacity - capacityRow.booked_count - reserve);

  return { available, capacity_max: capacityRow.max_capacity };
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

  // Load .env and .env.local (local overrides)
  const beforeKeys = new Set(Object.keys(process.env));
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".env.local", override: true });
  const afterKeys = new Set(Object.keys(process.env));
  const injectedCount = [...afterKeys].filter((key) => !beforeKeys.has(key)).length;

  // When using API key without SERVICEM8_VENDOR_UUID, try to fetch it from vendor.json
  if (process.env.SERVICEM8_API_KEY && !process.env.SERVICEM8_VENDOR_UUID) {
    const resolved = await resolveVendorUuidForApiKey();
    if (resolved) {
      process.env.SERVICEM8_VENDOR_UUID = resolved;
    }
  }

  // Register env plugin
  const envSchema = {
    type: "object",
    required: [],
    properties: {
      PORT: { type: "string", default: "3000" },
      VAPI_BEARER_TOKEN: { type: "string" },
      SERVICEM8_APP_ID: { type: "string" },
      SERVICEM8_APP_SECRET: { type: "string" },
      BASE_URL: { type: "string" },
      SERVICEM8_STAFF_UUID: { type: "string" },
      DEFAULT_STAFF_UUID: { type: "string" },
      BUSINESS_TZ: { type: "string", default: "Australia/Brisbane" },
      CRON_TOKEN: { type: "string" },
      DEBUG_KEY: { type: "string" },
      GIT_SHA: { type: "string" },
      BUILD_TIME: { type: "string" },
      SERVICEM8_QUEUE_UUID: { type: "string" },
      SERVICEM8_CATEGORY_UUID: { type: "string" },
      SERVICEM8_VENDOR_UUID: { type: "string" },
      SERVICEM8_API_KEY: { type: "string" },
      DATABASE_URL: { type: "string" },
      MAPS_PROVIDER: { type: "string", default: "google" },
      GOOGLE_MAPS_API_KEY: { type: "string" },
      BUSINESS_BASE_ADDRESS: { type: "string" },
      DISTANCE_ENABLED: { type: "string", default: "false" },
      SMS_ENABLED: { type: "string", default: "false" },
      DISTANCE_FAR_KM: { type: "string", default: "25" },
      DISTANCE_MEDIUM_KM: { type: "string", default: "10" },
      SMALL_JOB_KEYWORDS: { type: "string" },
      RISK_ENRICH_DRY_RUN: { type: "string", default: "false" },
      TWILIO_ACCOUNT_SID: { type: "string" },
      TWILIO_AUTH_TOKEN: { type: "string" },
      TWILIO_FROM_NUMBER: { type: "string" },
      SCHEDULING_V2: { type: "string", default: "false" },
      SCHEDULING_V2_MAX_JOBS_PER_WINDOW: { type: "string", default: "2" },
      SCHEDULING_V2_DEFAULT_DURATION_MINUTES: { type: "string", default: "120" },
      SCHEDULING_V2_BUFFER_RATIO: { type: "string", default: "0.2" },
      FEATURE_PROFIT_FLAGGING: { type: "string", default: "false" },
      DISPATCHER_MOBILE: { type: "string" },
      FIN_MINIMUM_CALLOUT: { type: "string" },
      FIN_INCLUDED_MINUTES: { type: "string" },
      FIN_HOURLY_RATE: { type: "string" },
      FIN_INTERNAL_COST_RATE: { type: "string" },
      FIN_OVERHEAD_PER_JOB: { type: "string" },
      FIN_REGRET_MARGIN_THRESHOLD: { type: "string" },
      FIN_HEALTHY_MARGIN_THRESHOLD: { type: "string" },
      DEV_TEST_ENDPOINTS: { type: "string", default: "false" },
      OVERRUN_PROTECTION_ENABLED: { type: "string", default: "false" },
      OVERRUN_GRACE_MINUTES: { type: "string", default: "15" },
      OVERRUN_MAJOR_DELAY_MINUTES: { type: "string", default: "90" },
    }
  };

  await fastify.register(env, {
    schema: envSchema,
    dotenv: true
  });

  const missingProdEnv = ["VAPI_BEARER_TOKEN", "SERVICEM8_APP_ID", "SERVICEM8_APP_SECRET", "DATABASE_URL"]
    .filter((key) => !fastify.config[key as keyof typeof fastify.config]);
  if ((process.env.NODE_ENV || "development") === "production" && missingProdEnv.length > 0) {
    fastify.log.error({ missingEnv: missingProdEnv }, "Missing required env vars");
    throw new Error(`Missing required env vars: ${missingProdEnv.join(", ")}`);
  }

  fastify.log.info(
    {
      env_files: [".env", ".env.local"],
      injected_keys: injectedCount,
      environment: process.env.NODE_ENV ?? "development",
    },
    "Env loaded"
  );

  fastify.log.info(
    {
      git_sha: fastify.config.GIT_SHA ?? "unknown",
      build_time: fastify.config.BUILD_TIME ?? "unknown",
      environment: process.env.NODE_ENV ?? "development",
    },
    "Server version"
  );

  const riskConfigValidation = validateRiskFeatureConfig();
  if (riskConfigValidation.issues.length > 0) {
    fastify.log.warn(
      { issues: riskConfigValidation.issues },
      "Risk enrichment configuration issues detected"
    );
  } else {
    fastify.log.info(
      {
        distance_enabled: riskConfigValidation.config.distanceEnabled,
        sms_enabled: riskConfigValidation.config.smsEnabled,
        dry_run: riskConfigValidation.config.riskEnrichDryRun,
      },
      "Risk enrichment configuration loaded"
    );
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

  const missingEnvFor = (keys: string[]) =>
    keys.filter((key) => !fastify.config[key as keyof typeof fastify.config]);

  const handleMissingEnv = (
    reply: any,
    context: any,
    missing: string[]
  ) => {
    const payload = {
      ok: false,
      error_code: "MISSING_ENV",
      message: `Missing env vars: ${missing.join(", ")}`,
      missing_fields: missing,
      normalized_preview: context.normalized ?? {},
    };
    return finalizeVapi(fastify, reply, context, payload, false, "MISSING_ENV");
  };

  fastify.setErrorHandler((error, request, reply) => {
    if (request.url.startsWith("/vapi/")) {
      fastify.log.error({ err: error, url: request.url }, "Vapi uncaught error");
      return reply.status(200).send({
        ok: false,
        error_code: "UNCAUGHT_ERROR",
        message: error.message || "Unexpected error",
      });
    }
    reply.status((error as any).statusCode ?? 500).send({
      ok: false,
      error: "internal_server_error",
    });
  });

  fastify.addHook("onRequest", async (request) => {
    if (request.url.startsWith("/vapi/")) {
      (request as any).__started_at_ms = Date.now();
    }
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/vapi/")) {
      return payload;
    }
    const contentType = reply.getHeader("content-type");
    const contentLength = reply.getHeader("content-length");
    request.log.info(
      { url: request.url, ct: contentType, len: contentLength },
      "onSend headers"
    );
    request.log.info(
      { url: request.url, payloadPreview: String(payload).slice(0, 500) },
      "onSend payload preview"
    );
    const started = (request as any).__started_at_ms ?? Date.now();
    const duration_ms = Date.now() - started;
    pushToolReceipt({
      method: request.method,
      path: request.url.split("?")[0] || request.url,
      status_code: reply.statusCode,
      duration_ms,
      request_body: request.body ?? null,
      response_body_preview: buildResponsePreview(payload),
    });
    return payload;
  });

  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/vapi/")) {
      return reply.status(200).send({
        ok: false,
        error_code: "NOT_FOUND",
        message: `Route ${request.method}:${request.url} not found`,
      });
    }
    return reply.status(404).send({
      message: `Route ${request.method}:${request.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });

  registerServiceM8AuthRoutes(fastify);

  // Health check endpoint
  fastify.get('/health', async (request, reply) => {
    return {
      ok: true,
      git_sha: fastify.config.GIT_SHA ?? "unknown",
      build_time: fastify.config.BUILD_TIME ?? "unknown",
    };
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

  fastify.get("/debug/last-vapi-calls", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true, calls: listVapiRing() });
  });

  fastify.get("/debug/last-booking-errors", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true, errors: listBookingErrors() });
  });

  fastify.get("/debug/tool-receipts", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true, receipts: listToolReceipts() });
  });

  fastify.get("/debug/booking", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).type("text/html").send("<h3>Unauthorized</h3><p>Provide X-DEBUG-KEY header or ?key=...</p>");
    }

    const errors = listBookingErrors();
    const bookingCalls = listVapiRing().filter((entry: any) =>
      String(entry?.endpoint || "").includes("/booking/") ||
      String(entry?.endpoint || "").includes("/book-window") ||
      String(entry?.endpoint || "").includes("/create-job")
    );

    const esc = (input: unknown) =>
      String(input ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");

    const renderRow = (obj: any) => `
      <tr>
        <td>${esc(obj.at)}</td>
        <td>${esc(obj.endpoint)}</td>
        <td>${esc(obj.request_id)}</td>
        <td>${esc(obj.error_code ?? obj.ok)}</td>
        <td><pre>${esc(JSON.stringify(obj, null, 2))}</pre></td>
      </tr>
    `;

    const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Booking Debug</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 20px; }
      h1 { margin-bottom: 4px; }
      .muted { color: #555; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
      th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; text-align: left; }
      th { background: #f6f6f6; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-width: 700px; }
    </style>
  </head>
  <body>
    <h1>Booking Debug</h1>
    <div class="muted">Latest booking calls and booking errors. Generated at ${new Date().toISOString()}</div>
    <h2>Booking Errors (${errors.length})</h2>
    <table>
      <thead><tr><th>At</th><th>Endpoint</th><th>Request ID</th><th>Error</th><th>Details</th></tr></thead>
      <tbody>${errors.map(renderRow).join("") || "<tr><td colspan='5'>No booking errors recorded.</td></tr>"}</tbody>
    </table>
    <h2>Recent Booking-Related Calls (${bookingCalls.length})</h2>
    <table>
      <thead><tr><th>At</th><th>Endpoint</th><th>Request ID</th><th>Status</th><th>Details</th></tr></thead>
      <tbody>${bookingCalls.map(renderRow).join("") || "<tr><td colspan='5'>No booking calls recorded.</td></tr>"}</tbody>
    </table>
  </body>
</html>`;

    return reply.type("text/html").send(html);
  });

  fastify.get("/debug/last-availability-errors", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }
    return reply.send({ ok: true, errors: listAvailabilityErrors() });
  });

  fastify.get("/debug/availability-cache", async (request, reply) => {
    if (!fastify.config.DEBUG_KEY) {
      return reply.status(500).send({ ok: false, error: "debug_key_missing" });
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    const provided = providedHeader || providedQuery;
    if (provided !== fastify.config.DEBUG_KEY) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const call_id = typeof (request.query as any)?.call_id === "string" ? (request.query as any).call_id : undefined;
    const vendor_uuid =
      typeof (request.query as any)?.vendor_uuid === "string" ? (request.query as any).vendor_uuid : undefined;
    const job_uuid = typeof (request.query as any)?.job_uuid === "string" ? (request.query as any).job_uuid : undefined;

    const entries = debugListAvailabilityEntries({ vendor_uuid, call_id, job_uuid });
    return reply.send({
      ok: true,
      filters: { call_id, vendor_uuid, job_uuid },
      count: entries.length,
      entries,
    });
  });

  fastify.post("/internal/cron/seed-capacity", async (request, reply) => {
    if (!fastify.config.CRON_TOKEN) {
      return reply.status(500).send({ ok: false, error: "cron_token_missing" });
    }
    const token = request.headers["x-cron-token"];
    const tokenValue = Array.isArray(token) ? token[0] : token || "";
    if (tokenValue !== fastify.config.CRON_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    await seedCapacityForAllVendors();

    return reply.send({ ok: true });
  });

  const runOverrunMonitorForAllVendors = async () => {
    const fromConfigs = await prisma.vendorConfig.findMany({
      select: { servicem8_vendor_uuid: true },
    });
    const fromConnections = await prisma.serviceM8Connection.findMany({
      select: { vendor_uuid: true },
    });
    const vendorSet = new Set<string>();
    for (const row of fromConfigs) {
      if (row.servicem8_vendor_uuid) {
        vendorSet.add(row.servicem8_vendor_uuid);
      }
    }
    for (const row of fromConnections) {
      if (row.vendor_uuid) {
        vendorSet.add(row.vendor_uuid);
      }
    }
    if (vendorSet.size === 0 && fastify.config.SERVICEM8_VENDOR_UUID) {
      vendorSet.add(fastify.config.SERVICEM8_VENDOR_UUID);
    }

    const results: Array<Record<string, unknown>> = [];
    for (const vendor_uuid of vendorSet) {
      try {
        const result = await runJobOverrunMonitor({
          vendor_uuid,
          dispatcher_mobile: fastify.config.DISPATCHER_MOBILE,
          logger: fastify.log,
        });
        results.push({ vendor_uuid, ...result });
      } catch (err: any) {
        fastify.log.error(
          {
            vendor_uuid,
            status: err?.status,
            body: err?.data,
            message: err?.message,
          },
          "SOP overrun monitor failed for vendor"
        );
        results.push({
          vendor_uuid,
          ok: false,
          error: err?.message || "overrun_monitor_failed",
        });
      }
    }
    return results;
  };

  fastify.post("/internal/cron/overrun-monitor", async (request, reply) => {
    if (!fastify.config.CRON_TOKEN) {
      return reply.status(500).send({ ok: false, error: "cron_token_missing" });
    }
    const token = request.headers["x-cron-token"];
    const tokenValue = Array.isArray(token) ? token[0] : token || "";
    if (tokenValue !== fastify.config.CRON_TOKEN) {
      return reply.status(401).send({ ok: false, error: "unauthorized" });
    }

    const results = await runOverrunMonitorForAllVendors();
    return reply.send({ ok: true, results });
  });

  const isDevHarnessEnabled = () => {
    const enabledFlag = String(fastify.config.DEV_TEST_ENDPOINTS || "").toLowerCase();
    return process.env.NODE_ENV !== "production" || enabledFlag === "true";
  };

  const authorizeDevHarness = (request: any, reply: any) => {
    if (!isDevHarnessEnabled()) {
      reply.status(404).send({ ok: false, error: "not_found" });
      return false;
    }
    if (!fastify.config.DEBUG_KEY) {
      return true;
    }
    const headerValue = request.headers["x-debug-key"];
    const providedHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue || "";
    const queryValue = (request.query as any)?.key;
    const providedQuery = typeof queryValue === "string" ? queryValue : "";
    if ((providedHeader || providedQuery) !== fastify.config.DEBUG_KEY) {
      reply.status(401).send({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  };

  fastify.post("/dev/test-profit-estimator", async (request, reply) => {
    if (!authorizeDevHarness(request, reply)) {
      return;
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const job_description = String(body.job_description || "").trim();
    const suburb = String(body.suburb || "").trim();
    const urgency = String(body.urgency || "this_week").trim();
    if (!job_description) {
      return reply.status(400).send({ ok: false, error: "job_description_required" });
    }

    const classification = classifyElectricalJob(job_description);
    const estimate = estimateProfit(classification.jobTypeKey, parseFinancialEnv());
    const note = buildProfitInsightNote({ classification, estimate });

    return reply.send({
      ok: true,
      input: { job_description, suburb, urgency },
      jobType: classification.jobTypeKey,
      estimatedDurationMins: {
        min: estimate.estimate.durationMinutes.min,
        max: estimate.estimate.durationMinutes.max,
        mid: Number((estimate.durationHoursMid * 60).toFixed(0)),
      },
      estimatedValue: {
        min: estimate.estimate.revenue.min,
        max: estimate.estimate.revenue.max,
        mid: Number(estimate.revenueMid.toFixed(0)),
      },
      flagLevel: estimate.marginStatus,
      servicem8NoteText: note,
    });
  });

  fastify.post("/dev/simulate-overrun", async (request, reply) => {
    if (!authorizeDevHarness(request, reply)) {
      return;
    }
    const body = (request.body || {}) as Record<string, unknown>;
    const job_uuid = String(body.job_uuid || "").trim();
    const minutesOverdue = Number(body.minutesOverdue);
    if (!job_uuid) {
      return reply.status(400).send({ ok: false, error: "job_uuid_required" });
    }
    if (!Number.isFinite(minutesOverdue) || minutesOverdue <= 0) {
      return reply.status(400).send({ ok: false, error: "minutesOverdue_invalid" });
    }

    const vendor_uuid =
      String(body.vendor_uuid || "").trim() ||
      fastify.config.SERVICEM8_VENDOR_UUID ||
      (await prisma.serviceM8Connection.findFirst({
        orderBy: { updated_at: "desc" },
        select: { vendor_uuid: true },
      }))?.vendor_uuid ||
      "";

    if (!vendor_uuid) {
      return reply.status(400).send({ ok: false, error: "vendor_uuid_required" });
    }

    const result = await simulateOverrunForJob({
      vendor_uuid,
      job_uuid,
      minutesOverdue,
      logger: fastify.log,
    });
    if (!result.ok) {
      return reply.status(404).send(result);
    }
    return reply.send(result);
  });

  fastify.post("/vapi/check-availability", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/check-availability";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const missingAuthEnv = missingEnvFor(["VAPI_BEARER_TOKEN"]);
    if (missingAuthEnv.length > 0) {
      return handleMissingEnv(reply, context, missingAuthEnv);
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      pushAvailabilityError({
        request_id,
        vendor_uuid: normalized.vendor_uuid,
        urgency: args?.urgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code: "INVALID_URGENCY",
        details: { endpoint, raw_urgency: args?.urgency },
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    const validation = vapiLightSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const urgency = validation.data.urgency;
    if (urgency === "today") {
      return finalizeVapi(fastify, reply, context, { ok: true, ...getAvailabilityForToday() }, true);
    }
    if (urgency === "emergency") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: true,
          available: true,
          window: "emergency",
          message: "We’ve logged this as urgent and will call within 15 minutes.",
        },
        true
      );
    }
    if (urgency === "quote_only") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: true,
          available: true,
          window: "quote_only",
          message: "We’ve logged your request and will follow up with a quote.",
        },
        true
      );
    }

    return finalizeVapi(
      fastify,
      reply,
      context,
      {
        ok: true,
        available: true,
        window: urgency,
        message: urgency === "next_week"
          ? "We can book you in next week."
          : "We can book you in this week.",
      },
      true
    );
  });

  fastify.post("/vapi/availability-window", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/availability-window";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const missingAuthEnv = missingEnvFor(["VAPI_BEARER_TOKEN"]);
    if (missingAuthEnv.length > 0) {
      return handleMissingEnv(reply, context, missingAuthEnv);
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    const validation = vapiLightSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const urgency = validation.data.urgency;
    const vendorUuid = validation.data.vendor_uuid;
    const config = await getBusinessConfig(vendorUuid);
    const name = args?.name || "there";
    const optionsResult = await getAvailabilityOptions({
      vendorUuid,
      urgency,
      preferredWindow: args?.preferred_window,
      now: args?.now_local ? new Date(args.now_local) : new Date(),
    });

    if (optionsResult.options.length > 0) {
      const option = optionsResult.options[0];
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: true,
          window_code: option.code,
          window_label: option.label,
          sms_template: `G’day ${name} — we can attend ${option.label}. Reply YES to confirm or NO for the next slot. – ${config.business_name}`,
        },
        true
      );
    }

    if (urgency === "emergency") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: true,
          window_code: "emergency",
          window_label: "Urgent callback",
          sms_template: `EMERGENCY: G’day ${name} — we’ve logged this as urgent. A technician will call within 15 minutes. – ${config.business_name}`,
        },
        true
      );
    }

    if (urgency === "quote_only") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: true,
          window_code: "quote_only",
          window_label: "Quote only",
          sms_template: `G’day ${name} — we’ve got your request and will send a quote. – ${config.business_name}`,
        },
        true
      );
    }

    return finalizeVapi(
      fastify,
      reply,
      context,
      {
        ok: true,
        window_code: "no_options",
        window_label: "No slots available",
        sms_template: `G’day ${name} — we’ll be in touch to arrange a time. – ${config.business_name}`,
      },
      true
    );
  });

  fastify.post("/vapi/send-window-sms", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/send-window-sms";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
      disable_result_envelope: true,
    };

    logVapiStart(fastify, context);

    const missingAuthEnv = missingEnvFor(["VAPI_BEARER_TOKEN"]);
    if (missingAuthEnv.length > 0) {
      return handleMissingEnv(reply, context, missingAuthEnv);
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiSendWindowSmsSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      job_uuid: normalized.job_uuid,
      mobile: normalized.mobile,
      first_name: normalized.first_name,
      window_code: normalized.window_code,
      window_label: normalized.window_label,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const normalizedMobile = normalizeMobile(validation.data.mobile);
    if (!normalizedMobile) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "VALIDATION_ERROR",
          message: "Invalid mobile",
          missing_fields: [],
          normalized_preview: normalized,
        },
        false,
        "VALIDATION_ERROR"
      );
    }

    try {
      const vendorUuid = validation.data.vendor_uuid;
      const config = await getBusinessConfig(vendorUuid);
      const message = `G’day ${validation.data.first_name} — we can attend ${validation.data.window_label}. Reply YES to confirm or NO for the next slot. – ${config.business_name}`;
      await sendServiceM8Sms({
        companyUuid: vendorUuid,
        toMobile: normalizedMobile,
        message,
        regardingJobUuid: validation.data.job_uuid,
      });

      const sm8 = await getServiceM8Client(vendorUuid);
      if (fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid: validation.data.job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `📅 Proposed window: ${validation.data.window_label} (${validation.data.window_code}) (auto)`,
        });
      }

      return finalizeVapi(fastify, reply, context, { ok: true, sms_sent: true }, true);
    } catch (err: any) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "ServiceM8 SMS failed",
          servicem8_status: err?.status,
          servicem8_body: err?.data,
        },
        false,
        "INTERNAL_ERROR"
      );
    }
  });

  fastify.post("/vapi/get-availability-options", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/get-availability-options";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const missingAuthEnv = missingEnvFor(["VAPI_BEARER_TOKEN"]);
    if (missingAuthEnv.length > 0) {
      return handleMissingEnv(reply, context, missingAuthEnv);
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    const validation = vapiLightSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const result = await getAvailabilityOptions({
      vendorUuid: validation.data.vendor_uuid,
      urgency: validation.data.urgency,
      preferredWindow: args?.preferred_window,
      now: args?.now_iso ? new Date(args.now_iso) : new Date(),
    });

    return finalizeVapi(
      fastify,
      reply,
      context,
      {
        ok: true,
        type: result.type,
        requires_callback: result.requires_callback,
        options: result.options,
      },
      true
    );
  });

  fastify.post("/vapi/get-availability", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/get-availability";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
      disable_result_envelope: true,
    };

    logVapiStart(fastify, context);

    if (!normalized.vendor_uuid) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "MISSING_VENDOR_UUID",
          message: "Missing vendor uuid. Provide servicem8_vendor_uuid or company_uuid.",
          normalized_preview: normalized,
        },
        false,
        "MISSING_VENDOR_UUID"
      );
    }

    const missingAuthEnv = missingEnvFor(["VAPI_BEARER_TOKEN"]);
    if (missingAuthEnv.length > 0) {
      return handleMissingEnv(reply, context, missingAuthEnv);
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    const validation = vapiLightSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const normalizedUrgency = validation.data.urgency;
    if (normalizedUrgency === "quote_only") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: true, message: "No available times found.", options: [] },
        true
      );
    }

    let morningWindowUuid: string | null = null;
    let arvoWindowUuid: string | null = null;
    try {
      const map = await getAllocationWindowMap(validation.data.vendor_uuid);
      morningWindowUuid = map.morningWindowUuid;
      arvoWindowUuid = map.arvoWindowUuid;
    } catch (err: any) {
      fastify.log.warn(
        {
          request_id,
          vendor_uuid: validation.data.vendor_uuid,
          status: err?.status,
          message: err?.message,
        },
        "get-availability allocation window map unavailable"
      );
    }
    const optionStaffUuid = process.env.DEFAULT_STAFF_UUID || process.env.SERVICEM8_STAFF_UUID || null;

    const options: Array<{
      code: string;
      label: string;
      date: string;
      window: "morning" | "afternoon";
      allocation_window_uuid: string | null;
      staff_uuid: string | null;
      start: string;
      end: string;
      start_time: string;
      end_time: string;
      capacity: {
        max_jobs: number;
        booked_jobs: number;
        remaining_jobs: number;
      };
    }> = [];
    const now = new Date();
    const preferredDay = typeof args?.preferred_day === "string" ? args.preferred_day : null;
    let cursor = preferredDay ? getNextWeekdayDate(now, preferredDay) : now;
    if (preferredDay && preferredDay.toLowerCase() === "tomorrow") {
      cursor = addDays(now, 1);
    }
    if (preferredDay && preferredDay.toLowerCase() === "today") {
      cursor = now;
    }
    if (normalizedUrgency === "next_week") {
      cursor = getNextWeekStart(now);
    }
    let daysAdded = 0;
    const targetDays = normalizedUrgency === "today" ? 1 : normalizedUrgency === "next_week" ? 5 : 3;

    while (options.length < targetDays * 2 && daysAdded < 14) {
      if (!isWeekendInBrisbane(cursor)) {
        const dateStr = getBrisbaneDateString(cursor);
        const labelPrefix = new Intl.DateTimeFormat("en-AU", {
          timeZone: process.env.BUSINESS_TZ || "Australia/Brisbane",
          weekday: "long",
        }).format(cursor);
        const morningLabel = `${labelPrefix} morning (8–12)`;
        const arvoLabel = `${labelPrefix} arvo (1–4)`;

        const morningStart = "08:00";
        const morningEnd = "12:00";
        const arvoStart = "13:00";
        const arvoEnd = "16:00";
        options.push({
          code: `${dateStr}_morning`,
          label: morningLabel,
          date: dateStr,
          window: "morning",
          allocation_window_uuid: morningWindowUuid,
          staff_uuid: optionStaffUuid,
          start: formatBrisbaneDateTime(dateStr, morningStart),
          end: formatBrisbaneDateTime(dateStr, morningEnd),
          start_time: morningStart,
          end_time: morningEnd,
          capacity: {
            max_jobs: 2,
            booked_jobs: 0,
            remaining_jobs: 2,
          },
        });
        options.push({
          code: `${dateStr}_arvo`,
          label: arvoLabel,
          date: dateStr,
          window: "afternoon",
          allocation_window_uuid: arvoWindowUuid,
          staff_uuid: optionStaffUuid,
          start: formatBrisbaneDateTime(dateStr, arvoStart),
          end: formatBrisbaneDateTime(dateStr, arvoEnd),
          start_time: arvoStart,
          end_time: arvoEnd,
          capacity: {
            max_jobs: 2,
            booked_jobs: 0,
            remaining_jobs: 2,
          },
        });
        if (options.length >= targetDays * 2) {
          break;
        }
      }
      cursor = addDays(cursor, 1);
      daysAdded += 1;
    }

    saveAvailabilityOptions({
      ...(context.call_id ? { call_id: context.call_id } : {}),
      vendor_uuid: validation.data.vendor_uuid,
      ...((normalized.job_uuid || getRecentJobUuidForVendor(validation.data.vendor_uuid))
        ? { job_uuid: normalized.job_uuid || getRecentJobUuidForVendor(validation.data.vendor_uuid) }
        : {}),
      options: options.map((option) => ({
        code: option.code,
        label: option.label,
        date: option.date,
        ...(toBookingWindow(option.window) ? { window: toBookingWindow(option.window) } : {}),
        start: option.start,
        end: option.end,
        start_time: option.start_time,
        end_time: option.end_time,
        ...(option.allocation_window_uuid ? { allocation_window_uuid: option.allocation_window_uuid } : {}),
        ...(option.staff_uuid ? { staff_uuid: option.staff_uuid } : {}),
      })),
    });
    return finalizeVapi(
      fastify,
      reply,
      context,
      { ok: true, message: optionsToResult(options), options },
      true
    );
  });

  fastify.post("/vapi/availability/windows", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/availability/windows";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const vendor_uuid = normalized.vendor_uuid;
    const normalizedWithVendor = { ...normalized, vendor_uuid };
    const context = {
      request_id,
      endpoint,
      vendor_uuid: vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized: normalizedWithVendor,
      started_at,
      disable_result_envelope: true,
    };

    logVapiStart(fastify, context);

    if (!vendor_uuid) {
      pushAvailabilityError({
        request_id,
        vendor_uuid: undefined,
        urgency: normalizedWithVendor.urgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code: "MISSING_VENDOR_UUID",
        details: { endpoint },
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "MISSING_VENDOR_UUID",
          message: "Missing vendor uuid. Provide servicem8_vendor_uuid or company_uuid.",
          result: "Booking is temporarily unavailable because vendor details are missing.",
          normalized_preview: normalizedWithVendor,
        },
        false,
        "MISSING_VENDOR_UUID"
      );
    }

    const envCheck = requireServiceM8Env({
      endpoint,
      request_id,
      call_id: normalized.call_id ?? meta.call_id,
    });
    if (!envCheck.ok) {
      pushAvailabilityError({
        request_id,
        vendor_uuid: vendor_uuid,
        urgency: normalizedWithVendor.urgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code: "SERVICEM8_ENV_MISSING",
        details: { missing_keys: envCheck.response.missing_keys },
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ...envCheck.response,
          result:
            envCheck.response?.message ??
            "Booking is temporarily unavailable because required settings are missing.",
        },
        false,
        "MISSING_ENV"
      );
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "UNAUTHORIZED",
          message: "Unauthorized",
          result: "Booking is temporarily unavailable due to authorization failure.",
        },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "INVALID_URGENCY",
          message: "Unsupported urgency",
          result: "Please choose one of: emergency, today, this_week, next_week, quote_only.",
        },
        false,
        "INVALID_URGENCY"
      );
    }

    const validation = vapiLightSchema.safeParse(normalizedWithVendor);
    if (!validation.success) {
      const payload = buildValidationPayload(normalizedWithVendor, validation.error);
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ...payload,
          result:
            payload.message ??
            "Booking is temporarily unavailable due to invalid availability request data.",
        },
        false,
        payload.error_code as string
      );
    }

    const normalizedUrgency = validation.data.urgency;
    const vendorUuid = validation.data.vendor_uuid;
    if (normalizedUrgency === "quote_only" || normalizedUrgency === "emergency") {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: true, message: "No available times found.", options: [] },
        true
      );
    }

    const config = await getVendorConfig(vendorUuid);
    const workingDays = getWorkingDays(config);
    let morningWindowUuid: string | null = null;
    let arvoWindowUuid: string | null = null;
    let windows: any[] = [];
    try {
      const map = await getAllocationWindowMap(vendorUuid);
      morningWindowUuid = map.morningWindowUuid;
      arvoWindowUuid = map.arvoWindowUuid;
      windows = map.windows ?? [];
    } catch (err: any) {
      const status = err?.status;
      const reason_code =
        status === 401
          ? "SERVICEM8_UNAUTH"
          : status === 403
            ? "SERVICEM8_INSUFFICIENT_SCOPE"
            : "ALLOCATION_WINDOWS_EMPTY";
      pushAvailabilityError({
        request_id,
        vendor_uuid: vendorUuid,
        urgency: normalizedUrgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code,
        details: { servicem8_status: status },
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: reason_code,
          message: "Allocation windows fetch failed",
          result:
            "Booking is temporarily unavailable because ServiceM8 availability could not be loaded.",
        },
        false,
        reason_code
      );
    }
    if (!morningWindowUuid || !arvoWindowUuid) {
      pushAvailabilityError({
        request_id,
        vendor_uuid: vendorUuid,
        urgency: normalizedUrgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code: "ALLOCATION_WINDOWS_EMPTY",
        details: { windows_count: Array.isArray(windows) ? windows.length : 0 },
      });
      fastify.log.warn({ vendorUuid, windows }, "Missing allocation windows");
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "Missing allocation windows",
          result:
            "Booking is temporarily unavailable because allocation windows are not configured.",
        },
        false,
        "INTERNAL_ERROR"
      );
    }

    const now = new Date();
    const { hour, minute } = getBrisbaneDateParts(now);
    const nowMinutes = hour * 60 + minute;
    const cutoffMinutes = parseTimeToMinutes(config.cutoff_today_arvo);
    const todayStr = getBrisbaneDateString(now);
    const schedulingV2 = isSchedulingV2Enabled();
    const schedulingAllocationsByDate = new Map<string, unknown[]>();
    let schedulingV2Staff: Array<{ uuid: string; work_start?: string; work_end?: string }> = [];
    let schedulingSm8Client: Awaited<ReturnType<typeof getServiceM8Client>> | null = null;
    if (schedulingV2) {
      try {
        schedulingSm8Client = await getServiceM8Client(vendorUuid);
        const staffRes = await schedulingSm8Client.getJson("/staff.json");
        schedulingV2Staff = mapServiceM8Staff(staffRes?.data);
      } catch (err: any) {
        fastify.log.warn(
          {
            request_id,
            vendor_uuid: vendorUuid,
            error: err?.message,
          },
          "Scheduling V2 staff preload failed; falling back to legacy capacity checks"
        );
      }
    }

    const options: Array<{
      code: string;
      date: string;
      window: "morning" | "afternoon";
      label: string;
      allocation_window_uuid: string;
      staff_uuid: string | null;
      start: string;
      end: string;
      start_time: string;
      end_time: string;
      capacity: {
        max_jobs: number;
        booked_jobs: number;
        remaining_jobs: number;
      };
    }> = [];
    let filteredPast = 0;
    let filteredCapacity = 0;

    const pushOption = async (date: Date, window: "morning" | "arvo") => {
      const dateStr = getBrisbaneDateString(date);
      const isToday = dateStr === todayStr;
      if (isToday && window === "morning" && nowMinutes >= 12 * 60) {
        filteredPast += 1;
        return;
      }
      if (isToday && window === "arvo" && nowMinutes >= cutoffMinutes) {
        filteredPast += 1;
        return;
      }

      const maxCapacity = window === "morning" ? config.morning_capacity : config.arvo_capacity;
      let capacityMeta = {
        max_jobs: maxCapacity,
        booked_jobs: 0,
        remaining_jobs: maxCapacity,
      };
      if (schedulingV2 && schedulingSm8Client && schedulingV2Staff.length > 0) {
        const available = await hasSchedulingV2Capacity({
          sm8: schedulingSm8Client,
          date: dateStr,
          window,
          morningWindowUuid,
          arvoWindowUuid,
          staff: schedulingV2Staff,
          allocationsByDate: schedulingAllocationsByDate,
        });
        if (!available) {
          filteredCapacity += 1;
          return;
        }
        capacityMeta = {
          max_jobs: maxCapacity,
          booked_jobs: 0,
          remaining_jobs: Math.max(1, maxCapacity),
        };
      } else {
        const capacity = await getAvailableCapacity({
          vendorUuid,
          date: dateStr,
          window,
          maxCapacity,
          emergencyReserve: config.emergency_reserve,
        });
        if (capacity.available <= 0) {
          filteredCapacity += 1;
          return;
        }
        const bookedCount =
          typeof capacity.row?.booked_count === "number"
            ? capacity.row.booked_count
            : Number(capacity.row?.booked_count || 0);
        capacityMeta = {
          max_jobs: maxCapacity,
          booked_jobs: Number.isFinite(bookedCount) ? bookedCount : 0,
          remaining_jobs: Math.max(0, capacity.available),
        };
      }

      const label = formatShortWindowLabel(date, window);
      const startTime = window === "morning" ? "08:00" : "13:00";
      const endTime = window === "morning" ? "12:00" : "16:00";
      options.push({
        code: `${dateStr}_${window}`,
        date: dateStr,
        window: toPublicWindow(window),
        label,
        allocation_window_uuid: window === "morning" ? morningWindowUuid : arvoWindowUuid,
        staff_uuid: process.env.DEFAULT_STAFF_UUID || process.env.SERVICEM8_STAFF_UUID || null,
        start: formatBrisbaneDateTime(dateStr, startTime),
        end: formatBrisbaneDateTime(dateStr, endTime),
        start_time: startTime,
        end_time: endTime,
        capacity: capacityMeta,
      });
    };

    const addBusinessDays = async (start: Date, count: number) => {
      let cursor = start;
      let added = 0;
      let scanned = 0;
      while (added < count && scanned < 20) {
        const weekday = getBrisbaneDateParts(cursor).weekday.toLowerCase();
        if (workingDays.includes(weekday)) {
          await pushOption(cursor, "morning");
          await pushOption(cursor, "arvo");
          added += 1;
        }
        cursor = addDays(cursor, 1);
        scanned += 1;
      }
    };

    if (normalizedUrgency === "today") {
      await addBusinessDays(now, 1);
    } else if (normalizedUrgency === "next_week") {
      await addBusinessDays(getNextWeekStart(now), 5);
    } else {
      await addBusinessDays(now, 3);
    }

    if (options.length === 0) {
      await addBusinessDays(addDays(now, 1), 14);
    }

    if (options.length === 0) {
      let reasonCode = "NO_WINDOWS_FINAL";
      if (filteredCapacity > 0) {
        reasonCode = "CAPACITY_ZERO";
      }
      if (filteredPast > 0 && filteredCapacity === 0) {
        reasonCode = "ALL_WINDOWS_FILTERED_PAST";
      }
      pushAvailabilityError({
        request_id,
        vendor_uuid: vendorUuid,
        urgency: normalizedUrgency,
        horizon: "14d",
        now_iso: new Date().toISOString(),
        tz: process.env.BUSINESS_TZ || "Australia/Brisbane",
        reason_code: reasonCode,
        details: { filtered_past: filteredPast, filtered_capacity: filteredCapacity },
      });
    }

    saveAvailabilityOptions({
      ...(context.call_id ? { call_id: context.call_id } : {}),
      vendor_uuid: vendorUuid,
      ...((normalizedWithVendor.job_uuid || getRecentJobUuidForVendor(vendorUuid))
        ? { job_uuid: normalizedWithVendor.job_uuid || getRecentJobUuidForVendor(vendorUuid) }
        : {}),
      options: options.map((option) => ({
        code: option.code,
        label: option.label,
        date: option.date,
        ...(toBookingWindow(option.window) ? { window: toBookingWindow(option.window) } : {}),
        start: option.start,
        end: option.end,
        allocation_window_uuid: option.allocation_window_uuid,
        start_time: option.start_time,
        end_time: option.end_time,
        ...(option.staff_uuid ? { staff_uuid: option.staff_uuid } : {}),
      })),
    });

    return finalizeVapi(
      fastify,
      reply,
      context,
      {
        ok: true,
        options: options.slice(0, 3).map((option) => ({
          code: option.code,
          label: option.label,
          date: option.date,
          window: option.window,
          allocation_window_uuid: option.allocation_window_uuid,
          staff_uuid: option.staff_uuid,
          start: option.start,
          end: option.end,
          start_time: option.start_time,
          end_time: option.end_time,
          capacity: option.capacity,
        })),
        message: optionsToResult(options),
      },
      true
    );
  });

  fastify.post("/vapi/book-window", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/book-window";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const effective_call_id = normalized.call_id ?? `${endpoint}:${request_id}`;
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: effective_call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const envCheck = requireServiceM8Env({
      endpoint,
      request_id,
      call_id: effective_call_id,
    });
    if (!envCheck.ok) {
      return finalizeVapi(fastify, reply, context, envCheck.response, false, "MISSING_ENV");
    }

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (!normalized.call_id) {
      fastify.log.warn({ endpoint, request_id }, "Missing call_id from Vapi; using generated fallback");
    }

    const validation = vapiBookWindowSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      job_uuid: normalized.job_uuid,
      mobile: normalized.mobile,
      first_name: normalized.first_name,
      selected_code: normalized.selected_code,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const stored =
      (normalized.call_id
        ? getAvailabilityOptionsForCall(normalized.call_id, validation.data.vendor_uuid)
        : null) ??
      getAvailabilityOptionsForBooking({
        vendor_uuid: validation.data.vendor_uuid,
        ...(validation.data.job_uuid ? { job_uuid: validation.data.job_uuid } : {}),
      });
    const matchedOption = resolveSelectedOptionFromStored({
      selected_code: validation.data.selected_code,
      storedOptions: stored?.options ?? [],
      now: new Date(),
    });
    if (!matchedOption) {
      const validCodes = trimBookingOptions(stored?.options ?? []).map((option) => option.code);
      const payload = buildReofferOptionsPayload({
        vendor_uuid: validation.data.vendor_uuid,
        call_id: normalized.call_id,
        job_uuid: validation.data.job_uuid,
        reason: "INVALID_SELECTED_CODE",
        message: "selected_code must come from getAvailability options.",
      });
      (payload as any).valid_codes = validCodes;
      (payload as any).valid_options = trimBookingOptions(stored?.options ?? []);
      fastify.log.warn(
        {
          request_id,
          endpoint,
          vendor_uuid: validation.data.vendor_uuid,
          call_id: normalized.call_id,
          job_uuid: validation.data.job_uuid,
          selected_code: validation.data.selected_code,
          valid_codes: validCodes,
        },
        "INVALID_SELECTED_CODE on /vapi/book-window"
      );
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(normalized.call_id ? { call_id: normalized.call_id } : {}),
        error_code: "INVALID_SELECTED_CODE",
        message: "selected_code must come from getAvailability options.",
        valid_codes: validCodes,
      });
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code);
    }

    let dateStr = typeof matchedOption.date === "string" ? matchedOption.date : undefined;
    let windowValue: "morning" | "arvo" | undefined = toBookingWindow(matchedOption.window);
    if ((!dateStr || !windowValue) && typeof matchedOption.code === "string") {
      const parsedFromCode = parseSelectedWindowCode(matchedOption.code, new Date());
      if (parsedFromCode) {
        dateStr = parsedFromCode.dateStr;
        windowValue = parsedFromCode.window === "MORNING" ? "morning" : "arvo";
      }
    }
    if (!dateStr || !windowValue) {
      const validCodes = trimBookingOptions(stored?.options ?? []).map((option) => option.code);
      const payload = buildReofferOptionsPayload({
        vendor_uuid: validation.data.vendor_uuid,
        call_id: normalized.call_id,
        job_uuid: validation.data.job_uuid,
        reason: "INVALID_SELECTED_CODE",
        message: "selected_code must resolve to a valid date/window option.",
      });
      (payload as any).valid_codes = validCodes;
      (payload as any).valid_options = trimBookingOptions(stored?.options ?? []);
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(normalized.call_id ? { call_id: normalized.call_id } : {}),
        error_code: "INVALID_SELECTED_CODE",
        message: "selected_code must resolve to a valid date/window option.",
        valid_codes: validCodes,
      });
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code);
    }

    const startTime = windowValue === "morning" ? "08:00" : "13:00";
    const endTime = windowValue === "morning" ? "12:00" : "16:00";
    const startIso = formatBrisbaneDateTime(dateStr, startTime);
    const endIso = formatBrisbaneDateTime(dateStr, endTime);

    const config = await getBusinessConfig(validation.data.vendor_uuid);
    const message = `G’day ${validation.data.first_name} — we’ve pencilled you in for ${windowValue} (${startTime}–${endTime}). Reply YES to confirm or NO for the next slot. – ${config.business_name}`;

    if (args?.dry_run) {
      const payload = {
        ok: true,
        dry_run: true,
        normalized_preview: normalized,
      };
      return finalizeVapi(fastify, reply, context, payload, true);
    }

    const buildBookingInput = (call_id: string) => ({
      request_id,
      endpoint,
      vendor_uuid: validation.data.vendor_uuid,
      call_id,
      job_uuid: validation.data.job_uuid,
      date: dateStr,
      window: windowValue as "morning" | "arvo",
      sms: {
        to_mobile: validation.data.mobile,
        message,
        job_uuid: validation.data.job_uuid,
      },
      record_booking: false,
      env: {
        business_tz: process.env.BUSINESS_TZ,
        queue_uuid: process.env.SERVICEM8_QUEUE_UUID,
        staff_uuid: process.env.DEFAULT_STAFF_UUID || process.env.SERVICEM8_STAFF_UUID,
      },
      logger: fastify.log,
    });
    let bookingResult = await bookWindow(buildBookingInput(effective_call_id));

    if ("replayResult" in bookingResult) {
      return finalizeVapi(fastify, reply, context, bookingResult.replayResult as any, true);
    }
    if (!bookingResult.ok) {
      bookingResult = await bookWindow(buildBookingInput(`${effective_call_id}:retry1`));
      if ("replayResult" in bookingResult) {
        return finalizeVapi(fastify, reply, context, bookingResult.replayResult as any, true);
      }
    }
    if (!bookingResult.ok) {
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: bookingResult.error_code,
      });
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(normalized.call_id ? { call_id: normalized.call_id } : {}),
        error_code: bookingResult.error_code,
        message: bookingResult.message,
        servicem8_status: bookingResult.servicem8_status,
        servicem8_body: bookingResult.servicem8_body,
      });
      const payload = {
        ...buildReofferOptionsPayload({
          vendor_uuid: validation.data.vendor_uuid,
          call_id: normalized.call_id,
          job_uuid: validation.data.job_uuid,
          reason: bookingResult.error_code,
          message: bookingResult.message || "Could not secure that slot.",
        }),
        debug_ref: bookingResult.debug_ref,
      };
      return finalizeVapi(
        fastify,
        reply,
        context,
        payload,
        false,
        payload.error_code
      );
    }

    const payload = {
      ok: true,
      scheduled: true,
      start: startIso,
      end: endIso,
      allocation_uuid: bookingResult.allocation_uuid,
      sms_sent: bookingResult.sms_sent ?? false,
      sms_error: bookingResult.sms_error,
    };
    return finalizeVapi(fastify, reply, context, payload, true);
  });

  fastify.post("/vapi/booking/book-window", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/booking/book-window";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const vendor_uuid = normalized.vendor_uuid ?? fastify.config.SERVICEM8_VENDOR_UUID;
    const normalizedWithVendor = { ...normalized, vendor_uuid };
    const effective_call_id = normalized.call_id ?? `${endpoint}:${request_id}`;
    const context = {
      request_id,
      endpoint,
      vendor_uuid: vendor_uuid,
      call_id: effective_call_id,
      tool_name: meta.tool_name,
      normalized: normalizedWithVendor,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiBookingBookWindowSchema.safeParse({
      call_id: normalized.call_id,
      vendor_uuid: vendor_uuid,
      job_uuid: normalizedWithVendor.job_uuid,
      selected_code: normalizedWithVendor.selected_code,
      allocation_window_uuid: normalizedWithVendor.allocation_window_uuid,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalizedWithVendor, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    if (args?.dry_run) {
      const payload = {
        ok: true,
        dry_run: true,
        normalized_preview: normalized,
      };
      return finalizeVapi(fastify, reply, context, payload, true);
    }

    if (!isUuid(validation.data.job_uuid)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        {
          ok: false,
          error_code: "INVALID_JOB_UUID",
          message: "job_uuid must be a UUID returned by createJob",
          normalized_preview: normalizedWithVendor,
        },
        false,
        "INVALID_JOB_UUID"
      );
    }

    const stored =
      (validation.data.call_id
        ? getAvailabilityOptionsForCall(validation.data.call_id, validation.data.vendor_uuid)
        : null) ??
      getAvailabilityOptionsForBooking({
        vendor_uuid: validation.data.vendor_uuid,
        ...(validation.data.job_uuid ? { job_uuid: validation.data.job_uuid } : {}),
      });
    const matchedOption = resolveSelectedOptionFromStored({
      selected_code: validation.data.selected_code,
      storedOptions: stored?.options ?? [],
      now: new Date(),
    });
    if (!matchedOption) {
      const validCodes = trimBookingOptions(stored?.options ?? []).map((option) => option.code);
      const payload = buildReofferOptionsPayload({
        vendor_uuid: validation.data.vendor_uuid,
        call_id: validation.data.call_id,
        job_uuid: validation.data.job_uuid,
        reason: "INVALID_SELECTED_CODE",
        message: "selected_code must come from getAvailability options.",
      });
      (payload as any).valid_codes = validCodes;
      (payload as any).valid_options = trimBookingOptions(stored?.options ?? []);
      fastify.log.warn(
        {
          request_id,
          endpoint,
          vendor_uuid: validation.data.vendor_uuid,
          call_id: validation.data.call_id,
          job_uuid: validation.data.job_uuid,
          selected_code: validation.data.selected_code,
          valid_codes: validCodes,
        },
        "INVALID_SELECTED_CODE on /vapi/booking/book-window"
      );
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(validation.data.call_id ? { call_id: validation.data.call_id } : {}),
        error_code: "INVALID_SELECTED_CODE",
        message: "selected_code must come from getAvailability options.",
        valid_codes: validCodes,
      });
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        payload,
        false,
        payload.error_code
      );
    }

    let date = typeof matchedOption.date === "string" ? matchedOption.date : undefined;
    let window: "morning" | "arvo" | undefined = toBookingWindow(matchedOption.window);
    if ((!date || !window) && typeof matchedOption.code === "string") {
      const parsed = parseSelectedWindowCode(matchedOption.code, new Date());
      if (parsed) {
        date = parsed.dateStr;
        window = parsed.window === "MORNING" ? "morning" : "arvo";
      }
    }
    if (!date || !window) {
      const validCodes = trimBookingOptions(stored?.options ?? []).map((option) => option.code);
      const payload = buildReofferOptionsPayload({
        vendor_uuid: validation.data.vendor_uuid,
        call_id: validation.data.call_id,
        job_uuid: validation.data.job_uuid,
        reason: "INVALID_SELECTED_CODE",
        message: "selected_code must resolve to a valid date/window option.",
      });
      (payload as any).valid_codes = validCodes;
      (payload as any).valid_options = trimBookingOptions(stored?.options ?? []);
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(validation.data.call_id ? { call_id: validation.data.call_id } : {}),
        error_code: "INVALID_SELECTED_CODE",
        message: "selected_code must resolve to a valid date/window option.",
        valid_codes: validCodes,
      });
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(
        fastify,
        reply,
        context,
        payload,
        false,
        payload.error_code
      );
    }

    const buildBookingInput = (call_id: string) => ({
      request_id,
      endpoint,
      vendor_uuid: validation.data.vendor_uuid,
      call_id,
      job_uuid: validation.data.job_uuid,
      date,
      window: window as "morning" | "arvo",
      allocation_window_uuid:
        (typeof matchedOption.allocation_window_uuid === "string" ? matchedOption.allocation_window_uuid : undefined)
        ?? validation.data.allocation_window_uuid,
      record_booking: true,
      env: {
        business_tz: process.env.BUSINESS_TZ,
        queue_uuid: process.env.SERVICEM8_QUEUE_UUID,
        staff_uuid: process.env.DEFAULT_STAFF_UUID || process.env.SERVICEM8_STAFF_UUID,
      },
      logger: fastify.log,
    });
    let bookingResult = await bookWindow(buildBookingInput(effective_call_id));

    if ("replayResult" in bookingResult) {
      return finalizeVapi(fastify, reply, context, bookingResult.replayResult as any, true);
    }
    if (!bookingResult.ok) {
      bookingResult = await bookWindow(buildBookingInput(`${effective_call_id}:retry1`));
      if ("replayResult" in bookingResult) {
        return finalizeVapi(fastify, reply, context, bookingResult.replayResult as any, true);
      }
    }
    if (!bookingResult.ok) {
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: bookingResult.error_code,
      });
      pushRouteBookingError({
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        ...(validation.data.call_id ? { call_id: validation.data.call_id } : {}),
        error_code: bookingResult.error_code,
        message: bookingResult.message,
        servicem8_status: bookingResult.servicem8_status,
        servicem8_body: bookingResult.servicem8_body,
      });
      const payload = {
        ...buildReofferOptionsPayload({
          vendor_uuid: validation.data.vendor_uuid,
          call_id: validation.data.call_id,
          job_uuid: validation.data.job_uuid,
          reason: bookingResult.error_code,
          message: bookingResult.message || "Could not secure that slot.",
        }),
        debug_ref: bookingResult.debug_ref,
      };
      return finalizeVapi(
        fastify,
        reply,
        context,
        payload,
        false,
        payload.error_code
      );
    }

    const payload = {
      ok: true,
      date: bookingResult.date,
      window: bookingResult.window,
      allocation_uuid: bookingResult.allocation_uuid,
      label: bookingResult.label,
      sms_sent: bookingResult.sms_sent ?? false,
    };
    return finalizeVapi(fastify, reply, context, payload, true);
  });

  fastify.post("/vapi/booking/cancel", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/booking/cancel";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const effective_call_id = normalized.call_id ?? `${endpoint}:${request_id}`;
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: effective_call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (!normalized.call_id) {
      fastify.log.warn({ endpoint, request_id }, "Missing call_id from Vapi; using generated fallback");
    }

    const validation = vapiBookingCancelSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      job_uuid: normalized.job_uuid,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const { run, replayResult } = await getOrStartToolRun(
      validation.data.vendor_uuid,
      endpoint,
      effective_call_id
    );
    if (replayResult) {
      return finalizeVapi(fastify, reply, context, replayResult as any, true);
    }

    const booking = await prisma.jobWindowBooking.findUnique({
      where: { job_uuid: validation.data.job_uuid },
    });
    if (!booking) {
      const payload = {
        ok: false,
        error_code: "VALIDATION_ERROR",
        message: "Booking not found",
        missing_fields: [],
        normalized_preview: normalized,
      };
      await finishToolRunFailure(run.id, "VALIDATION_ERROR");
      return finalizeVapi(fastify, reply, context, payload, false, "VALIDATION_ERROR");
    }

    const sm8 = await getServiceM8Client(validation.data.vendor_uuid);
    try {
      await sm8.deleteJson(`/joballocation/${booking.allocation_uuid}.json`);
    } catch (err) {
      fastify.log.warn({ jobUuid: validation.data.job_uuid, allocation_uuid: booking.allocation_uuid }, "Allocation delete failed");
    }

    await prisma.$transaction(async (tx) => {
      await tx.jobWindowBooking.update({
        where: { job_uuid: validation.data.job_uuid },
        data: { status: "cancelled" },
      });

      const capacity = await tx.windowCapacity.findUnique({
        where: {
          servicem8_vendor_uuid_date_window: {
            servicem8_vendor_uuid: validation.data.vendor_uuid,
            date: booking.date,
            window: booking.window,
          },
        },
      });

      if (capacity) {
        await tx.windowCapacity.update({
          where: { id: capacity.id },
          data: { booked_count: Math.max(0, capacity.booked_count - 1) },
        });
      }
    });

    const payload = { ok: true };
    await finishToolRunSuccess(run.id, payload);
    return finalizeVapi(fastify, reply, context, payload, true);
  });

  fastify.post("/sms/inbound", async (request, reply) => {
    const { args: body } = extractVapiArgs(request.body);
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

  fastify.post("/webhooks/sms/inbound", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const fromMobile =
      (typeof body.from === "string" ? body.from : undefined) ??
      (typeof body.From === "string" ? body.From : undefined) ??
      (typeof body.from_mobile === "string" ? body.from_mobile : undefined) ??
      (typeof body.FromNumber === "string" ? body.FromNumber : undefined);
    const text =
      (typeof body.body === "string" ? body.body : undefined) ??
      (typeof body.Body === "string" ? body.Body : undefined) ??
      (typeof body.message === "string" ? body.message : undefined);

    if (!fromMobile || !text) {
      return reply.status(400).send({ ok: false, error: "missing_from_or_body" });
    }

    const response = await handleTradieDecisionReply({
      fromMobile,
      body: text,
      smsEnabled: String(process.env.SMS_ENABLED || "false").toLowerCase() === "true",
      dryRun: String(process.env.RISK_ENRICH_DRY_RUN || "false").toLowerCase() === "true",
      logger: fastify.log,
    });

    return reply.send(response);
  });

  // Vapi ping endpoint with auth
  fastify.post('/vapi/ping', {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/ping";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiPingSchema.safeParse(normalized);
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    return finalizeVapi(fastify, reply, context, { ok: true }, true);
  });

  // Vapi create-job endpoint
  fastify.post('/vapi/create-job', {
    schema: {
      body: {
        type: "object",
      },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/create-job";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const vendor_uuid = normalized.vendor_uuid ?? fastify.config.SERVICEM8_VENDOR_UUID;
    const normalizedWithVendor = { ...normalized, vendor_uuid };
    const effective_call_id = normalized.call_id ?? `${endpoint}:${request_id}`;

    lastVapiCall = {
      at: new Date().toISOString(),
      body: args ?? null,
    };

    const context = {
      request_id,
      endpoint,
      vendor_uuid: vendor_uuid ?? undefined,
      call_id: effective_call_id,
      tool_name: meta.tool_name,
      normalized: normalizedWithVendor,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    if (args?.urgency && !normalizeVapiUrgency(args.urgency)) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "INVALID_URGENCY", message: "Unsupported urgency" },
        false,
        "INVALID_URGENCY"
      );
    }

    if (!normalized.call_id) {
      fastify.log.warn({ endpoint, request_id }, "Missing call_id from Vapi; using generated fallback");
    }

    const validation = vapiCreateJobSchema.safeParse(normalizedWithVendor);
    if (!validation.success) {
      const payload = buildValidationPayload(normalizedWithVendor, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const { run, replayResult } = await getOrStartToolRun(
      validation.data.vendor_uuid,
      endpoint,
      effective_call_id
    );
    if (replayResult) {
      return finalizeVapi(fastify, reply, context, replayResult as any, true);
    }

    const sm8 = await getServiceM8Client(validation.data.vendor_uuid);
    const mask = (value: string) => (value ? `${value.slice(0, 2)}***${value.slice(-2)}` : "");

    try {
      let firstName = validation.data.first_name?.trim();
      let lastName = validation.data.last_name?.trim();
      const name = typeof args?.name === "string" ? args.name : "";

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

      const normalizedMobile = normalizeMobile(validation.data.mobile);
      if (!normalizedMobile) {
        const payload = {
          ok: false,
          error_code: "VALIDATION_ERROR",
          message: "Invalid mobile",
          missing_fields: [],
          normalized_preview: normalizedWithVendor,
        };
        await finishToolRunFailure(run.id, "VALIDATION_ERROR");
        return finalizeVapi(fastify, reply, context, payload, false, "VALIDATION_ERROR");
      }

      const jobAddress = validation.data.address?.full
        ?? [validation.data.address?.street_number, validation.data.address?.street_name, validation.data.address?.suburb]
          .filter(Boolean)
          .join(" ");
      const jobDescription = validation.data.job_description;
      const normalizedUrgency = validation.data.urgency;

      const createKey = `${normalizedMobile}|${jobAddress?.trim().toLowerCase()}|${jobDescription?.trim().toLowerCase()}`;
      const nowTs = Date.now();
      for (const [key, value] of recentCreateJobs) {
        if (nowTs - value.at > 10 * 60 * 1000) {
          recentCreateJobs.delete(key);
        }
      }
      for (const [key, value] of recentJobByVendor) {
        if (nowTs - value.at > 30 * 60 * 1000) {
          recentJobByVendor.delete(key);
        }
      }
      const recent = recentCreateJobs.get(createKey);
      if (recent && nowTs - recent.at < 2 * 60 * 1000) {
        recentJobByVendor.set(validation.data.vendor_uuid, {
          at: nowTs,
          job_uuid: recent.job_uuid,
        });
        const job_number = recent.generated_job_id ? String(recent.generated_job_id) : "pending";
        const payload = {
          ok: true,
          job_uuid: recent.job_uuid,
          job_number,
          generated_job_id: recent.generated_job_id,
          sms_sent: recent.sms_sent,
          deduped: true,
          result: `Job created. job_uuid=${recent.job_uuid} job_number=${job_number}`,
        };
        await finishToolRunSuccess(run.id, payload);
        return finalizeVapi(fastify, reply, context, payload, true);
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
        const payload = {
          ok: false,
          error_code: "INTERNAL_ERROR",
          message: "Failed to create or find company",
        };
        await finishToolRunFailure(run.id, "INTERNAL_ERROR");
        return finalizeVapi(fastify, reply, context, payload, false, "INTERNAL_ERROR");
      }

      const brandedDescription = `NOYAKKA — ${jobDescription}`.trim();
      const queue_uuid = fastify.config.SERVICEM8_QUEUE_UUID || undefined;
      const category_uuid = fastify.config.SERVICEM8_CATEGORY_UUID || undefined;

      fastify.log.info(
        {
          queue_uuid,
          category_uuid,
          mobile: mask(normalizedMobile),
          job_address: mask(jobAddress),
        },
        "ServiceM8 create-job payload metadata"
      );

      const jobCreate = await sm8.postJson("/job.json", {
        company_uuid,
        job_description: brandedDescription,
        job_address: jobAddress,
        status: "Quote",
        ...(queue_uuid ? { queue_uuid } : {}),
        ...(category_uuid ? { category_uuid } : {}),
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
          note: `📞 Booked by Noyakka AI\nUrgency: ${normalizedUrgency}\nDescription: ${jobDescription}`,
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
      const vendorConfig = await getVendorConfig(validation.data.vendor_uuid);
      const jobNumberText = generated_job_id ? String(generated_job_id) : "pending";
      let emergencyBooking: {
        allocation_uuid: string;
        date: string;
        window: "morning" | "arvo";
        label: string;
        sms_sent: boolean;
      } | null = null;

      if (normalizedUrgency === "emergency") {
        if (fastify.config.SERVICEM8_STAFF_UUID) {
          await sm8.postJson("/jobactivity.json", {
            job_uuid,
            staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
            type: "note",
            note: "⚠️ EMERGENCY job created (callback within 15 mins)",
          });
        }

        const emergencyResult = await autoBookEmergency({
          vendorUuid: validation.data.vendor_uuid,
          jobUuid: job_uuid,
          firstName,
          toMobile: normalizedMobile,
          jobAddress: jobAddress,
          jobNumber: jobNumberText,
        });
        if (emergencyResult.ok) {
          emergencyBooking = emergencyResult.booking;
          sms_sent = emergencyBooking.sms_sent;
        } else {
          sms_failure_reason = emergencyResult.error || "Emergency booking failed";
        }
      }

      if (!emergencyBooking) {
        const sms_message = buildLoggedSms({
          first_name: firstName,
          job_number: jobNumberText,
          job_address: jobAddress,
          business_name: vendorConfig.business_name,
        });
        try {
          await sendServiceM8Sms({
            companyUuid: validation.data.vendor_uuid,
            toMobile: normalizedMobile,
            message: sms_message,
            regardingJobUuid: job_uuid,
          });
          sms_sent = true;
        } catch (err: any) {
          sms_failure_reason = err?.status ? `ServiceM8 SMS failed (${err.status})` : "ServiceM8 SMS failed";
        }
      }

      if (!sms_sent && sms_failure_reason && fastify.config.SERVICEM8_STAFF_UUID) {
        await sm8.postJson("/jobactivity.json", {
          job_uuid,
          staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
          type: "note",
          note: `⚠️ SMS confirmation failed: ${sms_failure_reason}`,
        });
      }

      if (String(process.env.FEATURE_PROFIT_FLAGGING || "false").toLowerCase() === "true") {
        try {
          await runProfitInsightForJob({
            sm8,
            vendor_uuid: validation.data.vendor_uuid,
            job_uuid,
            job_number: jobNumberText,
            job_description: jobDescription,
            job_address: jobAddress,
            staff_uuid: fastify.config.SERVICEM8_STAFF_UUID,
            dispatcher_mobile: process.env.DISPATCHER_MOBILE,
            logger: fastify.log,
          });
        } catch (err: any) {
          fastify.log.warn(
            {
              request_id,
              job_uuid,
              error: err?.message,
              status: err?.status,
            },
            "Profit insight generation failed"
          );
        }
      }

      const responsePayload = {
        ok: true,
        job_uuid,
        job_number: jobNumberText,
        generated_job_id,
        sms_sent,
        booking: emergencyBooking ?? null,
        result: `Job created. job_uuid=${job_uuid} job_number=${jobNumberText}`,
      };

      recentCreateJobs.set(createKey, {
        at: nowTs,
        job_uuid,
        generated_job_id,
        sms_sent,
      });
      recentJobByVendor.set(validation.data.vendor_uuid, {
        at: nowTs,
        job_uuid,
      });

      await finishToolRunSuccess(run.id, responsePayload);
      return finalizeVapi(fastify, reply, context, responsePayload, true);
    } catch (err: any) {
      const payload = {
        ok: false,
        error_code: "INTERNAL_ERROR",
        message: "ServiceM8 error",
        servicem8_status: err.status,
        servicem8_body: err.data,
      };
      await finishToolRunFailure(run.id, "INTERNAL_ERROR");
      return finalizeVapi(fastify, reply, context, payload, false, "INTERNAL_ERROR");
    }
  });

  // Vapi create-lead endpoint (job + contact + note)
  fastify.post("/vapi/create-lead", {
    schema: {
      body: { type: "object" },
    },
  }, buildCreateLeadHandler(fastify));

  fastify.post("/vapi/send-booked-sms", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/send-booked-sms";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiSendBookedSmsSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      mobile: normalized.mobile,
      first_name: normalized.first_name,
      date_label: normalized.date_label,
      window_label: normalized.window_label,
      time_range: normalized.time_range,
      job_number: normalized.job_number,
      address: normalized.address,
      business_name: normalized.business_name,
      job_uuid: normalized.job_uuid,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const normalizedMobile = normalizeMobile(validation.data.mobile);
    if (!normalizedMobile) {
      const payload = {
        ok: false,
        error_code: "VALIDATION_ERROR",
        message: "Invalid mobile",
        missing_fields: [],
        normalized_preview: normalized,
      };
      return finalizeVapi(fastify, reply, context, payload, false, "VALIDATION_ERROR");
    }

    if (!validation.data.job_uuid) {
      const payload = {
        ok: false,
        error_code: "BOOKING_NOT_CONFIRMED",
        message: "job_uuid is required before sending booked confirmation SMS.",
      };
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code);
    }

    const booking = await prisma.jobWindowBooking.findUnique({
      where: { job_uuid: validation.data.job_uuid },
    });
    if (!booking || booking.status !== "confirmed") {
      const payload = {
        ok: false,
        error_code: "BOOKING_NOT_CONFIRMED",
        message: "Booking is not confirmed yet. Please run bookWindow successfully first.",
      };
      logOpsEvent(fastify.log, "BOOKING_FAILED", {
        request_id,
        endpoint,
        vendor_uuid: validation.data.vendor_uuid,
        job_uuid: validation.data.job_uuid,
        reason: payload.error_code,
      });
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code);
    }

    const message = buildBookedSms({
      first_name: validation.data.first_name,
      date_label: validation.data.date_label,
      window_label: validation.data.window_label,
      time_range: validation.data.time_range,
      job_number: validation.data.job_number,
      job_address: validation.data.address.full ?? "",
      business_name: validation.data.business_name || "Noyakka",
    });

    await sendServiceM8Sms({
      companyUuid: validation.data.vendor_uuid,
      toMobile: normalizedMobile,
      message,
      regardingJobUuid: validation.data.job_uuid,
    });

    return finalizeVapi(fastify, reply, context, { ok: true }, true);
  });

  fastify.post("/vapi/send-logged-sms", {
    schema: {
      body: { type: "object" },
    },
  }, async (request, reply) => {
    const request_id = randomUUID();
    const started_at = Date.now();
    const endpoint = "/vapi/send-logged-sms";
    const { args, meta } = extractVapiArgs(request.body);
    const normalized = normalizeVapiArgs({ ...args, ...meta });
    const context = {
      request_id,
      endpoint,
      vendor_uuid: normalized.vendor_uuid,
      call_id: normalized.call_id ?? meta.call_id,
      tool_name: meta.tool_name,
      normalized,
      started_at,
    };

    logVapiStart(fastify, context);

    const token = extractBearerToken(request.headers);
    if (token !== fastify.config.VAPI_BEARER_TOKEN) {
      return finalizeVapi(
        fastify,
        reply,
        context,
        { ok: false, error_code: "UNAUTHORIZED", message: "Unauthorized" },
        false,
        "UNAUTHORIZED"
      );
    }

    const validation = vapiSendLoggedSmsSchema.safeParse({
      vendor_uuid: normalized.vendor_uuid,
      mobile: normalized.mobile,
      first_name: normalized.first_name,
      job_number: normalized.job_number,
      address: normalized.address,
      business_name: normalized.business_name,
      job_uuid: normalized.job_uuid,
    });
    if (!validation.success) {
      const payload = buildValidationPayload(normalized, validation.error);
      return finalizeVapi(fastify, reply, context, payload, false, payload.error_code as string);
    }

    const normalizedMobile = normalizeMobile(validation.data.mobile);
    if (!normalizedMobile) {
      const payload = {
        ok: false,
        error_code: "VALIDATION_ERROR",
        message: "Invalid mobile",
        missing_fields: [],
        normalized_preview: normalized,
      };
      return finalizeVapi(fastify, reply, context, payload, false, "VALIDATION_ERROR");
    }

    const message = buildLoggedSms({
      first_name: validation.data.first_name,
      job_number: validation.data.job_number,
      job_address: validation.data.address.full ?? "",
      business_name: validation.data.business_name || "Noyakka",
    });

    await sendServiceM8Sms({
      companyUuid: validation.data.vendor_uuid,
      toMobile: normalizedMobile,
      message,
      regardingJobUuid: validation.data.job_uuid,
    });

    return finalizeVapi(fastify, reply, context, { ok: true }, true);
  });

  // Vapi send-sms endpoint (logs SMS pending)
  fastify.post("/vapi/send-sms", {
    schema: {
      body: { type: "object" },
    },
  }, buildSendSmsHandler(fastify));

  try {
    const port = Number(process.env.PORT ?? 3000);
    const host = "0.0.0.0";
    
    await fastify.listen({ port, host });
    console.log(`listening on http://${host}:${port}`);

    setInterval(async () => {
      const { year, month, day, hour, minute } = getBrisbaneDateParts(new Date());
      if (hour === 0 && minute === 5) {
        const key = `${year}-${month}-${day}`;
        if (lastCapacitySeedDate !== key) {
          try {
            await seedCapacityForAllVendors();
            lastCapacitySeedDate = key;
          } catch (err) {
            fastify.log.error(err, "Capacity seed failed");
          }
        }
      }
    }, 60_000);

    setInterval(async () => {
      try {
        await runOverrunMonitorForAllVendors();
      } catch (err) {
        fastify.log.error(err, "SOP overrun monitor tick failed");
      }
    }, 15 * 60_000);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
