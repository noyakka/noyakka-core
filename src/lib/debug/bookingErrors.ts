type BookingErrorEntry = {
  request_id: string;
  endpoint: string;
  vendor_uuid?: string;
  call_id?: string;
  job_uuid?: string;
  date?: string;
  window?: string;
  allocation_window_uuid?: string;
  valid_codes?: string[];
  error_code: string;
  message?: string;
  servicem8_status?: number;
  servicem8_body?: unknown;
  at: string;
};

const MAX_ERRORS = 20;
const buffer: BookingErrorEntry[] = [];

const redactMobile = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") {
    return value;
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length <= 3) {
    return "***";
  }
  return `***${digits.slice(-3)}`;
};

const redactAddress = (value: any) => {
  if (!value || typeof value !== "object") {
    return value;
  }
  const suburb = value.suburb;
  const street_number = value.street_number;
  const fullParts = [street_number, suburb].filter(Boolean);
  return {
    suburb,
    street_number,
    full: fullParts.length > 0 ? fullParts.join(" ") : undefined,
  };
};

const redactBody = (body: unknown) => {
  if (!body || typeof body !== "object") {
    return body;
  }
  const value = body as any;
  return {
    ...value,
    mobile: redactMobile(value.mobile),
    address: redactAddress(value.address),
  };
};

export const push = (entry: Omit<BookingErrorEntry, "at">) => {
  const item: BookingErrorEntry = {
    ...entry,
    servicem8_body: redactBody(entry.servicem8_body),
    at: new Date().toISOString(),
  };
  buffer.push(item);
  if (buffer.length > MAX_ERRORS) {
    buffer.splice(0, buffer.length - MAX_ERRORS);
  }
};

export const list = () => {
  return [...buffer].reverse();
};
