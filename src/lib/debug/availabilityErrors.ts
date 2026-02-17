type AvailabilityErrorEntry = {
  request_id: string;
  vendor_uuid?: string;
  urgency?: string;
  horizon?: string;
  now_iso?: string;
  tz?: string;
  reason_code: string;
  details?: any;
  at: string;
};

const MAX_ERRORS = 50;
const buffer: AvailabilityErrorEntry[] = [];

const redactDetails = (details: any) => {
  if (!details || typeof details !== "object") {
    return details;
  }
  return {
    ...details,
    mobile: undefined,
    address: undefined,
    job_description: undefined,
  };
};

export const push = (entry: Omit<AvailabilityErrorEntry, "at">) => {
  const item: AvailabilityErrorEntry = {
    ...entry,
    details: redactDetails(entry.details),
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
