type VapiRingEntry = {
  request_id: string;
  endpoint: string;
  vendor_uuid?: string;
  call_id?: string;
  tool_name?: string;
  normalized_urgency?: string;
  ok: boolean;
  error_code?: string;
  duration_ms: number;
  normalized_preview?: any;
  at: string;
};

const MAX_ENTRIES = 50;
const buffer: VapiRingEntry[] = [];

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

const truncate = (value: unknown, length: number) => {
  if (typeof value !== "string") {
    return value;
  }
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, length)}...`;
};

const redactPreview = (preview: any) => {
  if (!preview || typeof preview !== "object") {
    return preview;
  }
  return {
    ...preview,
    mobile: redactMobile(preview.mobile),
    address: redactAddress(preview.address),
    job_description: truncate(preview.job_description, 80),
  };
};

export const push = (entry: Omit<VapiRingEntry, "at" | "normalized_preview"> & { normalized_preview?: any }) => {
  const item: VapiRingEntry = {
    ...entry,
    normalized_preview: redactPreview(entry.normalized_preview),
    at: new Date().toISOString(),
  };

  buffer.push(item);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
};

export const list = () => {
  return [...buffer].reverse();
};
