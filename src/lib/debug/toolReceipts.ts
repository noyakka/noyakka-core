type ToolReceiptEntry = {
  at: string;
  method: string;
  path: string;
  status_code: number;
  duration_ms: number;
  request_body: unknown;
  response_body_preview: string;
};

const MAX_ENTRIES = 100;
const MAX_RESPONSE_PREVIEW = 2048;
const buffer: ToolReceiptEntry[] = [];

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

const redactObject = (input: unknown): unknown => {
  if (!input || typeof input !== "object") {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item));
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("authorization") ||
      lower.includes("token") ||
      lower.includes("secret") ||
      lower.includes("password")
    ) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (lower.includes("mobile") || lower.includes("phone")) {
      out[key] = redactMobile(value);
      continue;
    }
    out[key] = redactObject(value);
  }
  return out;
};

const toPreview = (payload: unknown) => {
  let text = "";
  if (typeof payload === "string") {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString("utf8");
  } else if (payload === undefined || payload === null) {
    text = "";
  } else {
    try {
      text = JSON.stringify(payload);
    } catch {
      text = String(payload);
    }
  }
  if (text.length <= MAX_RESPONSE_PREVIEW) {
    return text;
  }
  return `${text.slice(0, MAX_RESPONSE_PREVIEW)}...`;
};

export const pushToolReceipt = (entry: Omit<ToolReceiptEntry, "at">) => {
  buffer.push({
    ...entry,
    request_body: redactObject(entry.request_body),
    at: new Date().toISOString(),
  });
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
};

export const listToolReceipts = () => {
  return [...buffer].reverse();
};

export const buildResponsePreview = toPreview;
