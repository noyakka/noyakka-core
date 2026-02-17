export type Urgency = "emergency" | "today" | "this_week" | "next_week" | "quote_only";
export type Window = "morning" | "arvo";

export type NormalizedVapiArgs = {
  vendor_uuid?: string;
  call_id?: string;
  urgency?: Urgency;
  window?: Window;
  date?: string;
  job_uuid?: string;
  allocation_window_uuid?: string;
  window_code?: string;
  window_label?: string;
  date_label?: string;
  time_range?: string;
  job_number?: string;
  business_name?: string;
  message?: string;
  selected_code?: string;
  regarding_job_uuid?: string;
  email?: string;
  call_summary?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  mobile?: string;
  address?: {
    suburb?: string;
    street_number?: string;
    street_name?: string;
    full?: string;
  };
  job_description?: string;
};

const normalizeText = (input: string) =>
  input
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "_");

export const normalizeUrgency = (input: string | null | undefined): Urgency | null => {
  if (!input) {
    return null;
  }
  const value = normalizeText(String(input));
  if (value.includes("emergency") || value.includes("urgent")) {
    return "emergency";
  }
  if (value === "today" || value === "todays" || value === "same_day") {
    return "today";
  }
  if (value === "next_week" || value === "nextweek") {
    return "next_week";
  }
  if (value === "this_week" || value === "thisweek" || value === "week") {
    return "this_week";
  }
  if (value === "quote" || value === "quote_only" || value === "quoteonly") {
    return "quote_only";
  }
  return null;
};

export const normalizeWindow = (input: string | null | undefined): Window | null => {
  if (!input) {
    return null;
  }
  const value = normalizeText(String(input));
  if (value === "morning" || value === "am") {
    return "morning";
  }
  if (value === "arvo" || value === "afternoon" || value === "pm") {
    return "arvo";
  }
  return null;
};

const normalizeDate = (input: unknown) => {
  if (typeof input !== "string") {
    return undefined;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? input : undefined;
};

export const normalizeVapiArgs = (extracted: any): NormalizedVapiArgs => {
  const hasWrapped = extracted && typeof extracted === "object" && ("args" in extracted || "meta" in extracted);
  const args = hasWrapped ? extracted?.args ?? {} : extracted ?? {};
  const meta = hasWrapped ? extracted?.meta ?? {} : {};

  const envVendorUuid =
    process.env.SERVICEM8_VENDOR_UUID ??
    process.env.SERVICEM8_COMPANY_UUID ??
    undefined;
  const vendor_uuid =
    args.servicem8_vendor_uuid ??
    args.company_uuid ??
    args.companyUuid ??
    args.vendor_uuid ??
    envVendorUuid;

  const call_id =
    meta.call_id ??
    args.call_id ??
    args.callId ??
    args.tool_call_id ??
    args.toolCallId ??
    undefined;

  const urgency = normalizeUrgency(args.urgency);
  const window = normalizeWindow(
    args.window ??
      args.preferred_window ??
      args.preferredWindow ??
      args.time_window ??
      args.timeWindow
  );

  const date = normalizeDate(args.date ?? args.booking_date ?? args.allocation_date);

  const job_uuid = args.job_uuid ?? args.jobUuid ?? args.job_id ?? args.jobId;
  const allocation_window_uuid =
    args.allocation_window_uuid ?? args.allocationWindowUuid ?? args.allocation_window;
  const window_code = args.window_code ?? args.windowCode;
  const window_label = args.window_label ?? args.windowLabel;
  const date_label = args.date_label ?? args.dateLabel;
  const time_range = args.time_range ?? args.timeRange;
  const job_number = args.job_number ?? args.jobNumber ?? args.generated_job_id ?? args.job_no;
  const business_name = args.business_name ?? args.businessName;
  const message = args.message;
  const selected_code =
    args.selected_code ?? args.selectedCode ?? args.window_code ?? args.windowCode;
  const regarding_job_uuid =
    args.regarding_job_uuid ?? args.regardingJobUuid ?? args.regarding_job;
  const email = args.email ?? args.customer_email ?? args.customerEmail;
  const call_summary = args.call_summary ?? args.callSummary;
  const name = args.name;

  const first_name = args.first_name ?? args.customer_first_name ?? args.customerFirstName;
  const last_name = args.last_name ?? args.customer_last_name ?? args.customerLastName;
  const mobile = args.mobile ?? args.to_mobile ?? args.phone ?? args.customer_mobile;

  const address = {
    suburb: args.suburb ?? args.address?.suburb,
    street_number:
      args.street_number ??
      args.streetNumber ??
      args.address?.street_number ??
      args.address?.streetNumber,
    street_name:
      args.street_name ??
      args.streetName ??
      args.address?.street_name ??
      args.address?.streetName,
    full:
      args.job_address ??
      args.full_address ??
      args.address?.full ??
      (typeof args.address === "string" ? args.address : undefined),
  };
  const hasAddress = Object.values(address).some((value) => Boolean(value));

  const job_description = args.job_description ?? args.description ?? args.jobDescription;

  return {
    vendor_uuid,
    call_id,
    urgency: urgency ?? undefined,
    window: window ?? undefined,
    date,
    job_uuid: job_uuid ?? undefined,
    allocation_window_uuid: allocation_window_uuid ?? undefined,
    window_code: window_code ?? undefined,
    window_label: window_label ?? undefined,
    date_label: date_label ?? undefined,
    time_range: time_range ?? undefined,
    job_number: job_number ?? undefined,
    business_name: business_name ?? undefined,
    message: message ?? undefined,
    selected_code: selected_code ?? undefined,
    regarding_job_uuid: regarding_job_uuid ?? undefined,
    email: email ?? undefined,
    call_summary: call_summary ?? undefined,
    name: name ?? undefined,
    first_name: first_name ?? undefined,
    last_name: last_name ?? undefined,
    mobile: mobile ?? undefined,
    address: hasAddress ? address : undefined,
    job_description: job_description ?? undefined,
  };
};
