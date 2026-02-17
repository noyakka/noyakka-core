type AvailabilityOption = {
  code: string;
  label?: string;
  date?: string;
  window?: string;
  start?: string;
  end?: string;
  allocation_window_uuid?: string;
};

type AvailabilityEntry = {
  call_id?: string;
  vendor_uuid: string;
  job_uuid?: string;
  options: AvailabilityOption[];
  expires_at: number;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const byCallId = new Map<string, AvailabilityEntry>();
const byVendor = new Map<string, AvailabilityEntry>();
const byJobUuid = new Map<string, AvailabilityEntry>();

const pruneExpired = () => {
  const now = Date.now();
  for (const [key, entry] of byCallId.entries()) {
    if (entry.expires_at <= now) {
      byCallId.delete(key);
    }
  }
  for (const [key, entry] of byVendor.entries()) {
    if (entry.expires_at <= now) {
      byVendor.delete(key);
    }
  }
  for (const [key, entry] of byJobUuid.entries()) {
    if (entry.expires_at <= now) {
      byJobUuid.delete(key);
    }
  }
  if (byCallId.size > MAX_ENTRIES) {
    const keys = [...byCallId.keys()];
    const deleteCount = byCallId.size - MAX_ENTRIES;
    for (let i = 0; i < deleteCount; i += 1) {
      byCallId.delete(keys[i] as string);
    }
  }
};

export const saveAvailabilityOptions = (input: {
  call_id?: string;
  vendor_uuid: string;
  job_uuid?: string;
  options: AvailabilityOption[];
}) => {
  if (!input.vendor_uuid) {
    return;
  }
  pruneExpired();
  const entry: AvailabilityEntry = {
    call_id: input.call_id,
    vendor_uuid: input.vendor_uuid,
    job_uuid: input.job_uuid,
    options: input.options,
    expires_at: Date.now() + TTL_MS,
  };
  if (input.call_id) {
    byCallId.set(input.call_id, entry);
  }
  byVendor.set(input.vendor_uuid, entry);
  if (input.job_uuid) {
    byJobUuid.set(input.job_uuid, entry);
  }
};

export const getAvailabilityOptionsForCall = (call_id: string, vendor_uuid: string) => {
  pruneExpired();
  const entry = byCallId.get(call_id);
  if (!entry) {
    return null;
  }
  if (entry.vendor_uuid !== vendor_uuid) {
    return null;
  }
  return entry;
};

export const getAvailabilityOptionsForBooking = (input: {
  call_id?: string;
  vendor_uuid: string;
  job_uuid?: string;
}) => {
  pruneExpired();

  if (input.call_id) {
    const byCall = byCallId.get(input.call_id);
    if (byCall && byCall.vendor_uuid === input.vendor_uuid) {
      return byCall;
    }
  }

  if (input.job_uuid) {
    const byJob = byJobUuid.get(input.job_uuid);
    if (byJob && byJob.vendor_uuid === input.vendor_uuid) {
      return byJob;
    }
  }

  const byVendorEntry = byVendor.get(input.vendor_uuid);
  if (byVendorEntry) {
    return byVendorEntry;
  }

  return null;
};

export const debugListAvailabilityEntries = (input?: {
  vendor_uuid?: string;
  call_id?: string;
  job_uuid?: string;
}) => {
  pruneExpired();
  const now = Date.now();
  const rows: AvailabilityEntry[] = [];
  const seen = new Set<string>();

  const pushUnique = (entry: AvailabilityEntry | undefined | null) => {
    if (!entry) return;
    const key = `${entry.vendor_uuid}:${entry.call_id || "-"}:${entry.job_uuid || "-"}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(entry);
  };

  if (input?.call_id && input?.vendor_uuid) {
    pushUnique(getAvailabilityOptionsForCall(input.call_id, input.vendor_uuid));
  } else if (input?.job_uuid) {
    pushUnique(byJobUuid.get(input.job_uuid));
  } else if (input?.vendor_uuid) {
    pushUnique(byVendor.get(input.vendor_uuid));
    for (const entry of byCallId.values()) {
      if (entry.vendor_uuid === input.vendor_uuid) {
        pushUnique(entry);
      }
    }
  } else {
    for (const entry of byCallId.values()) {
      pushUnique(entry);
    }
    for (const entry of byVendor.values()) {
      pushUnique(entry);
    }
  }

  return rows
    .sort((a, b) => b.expires_at - a.expires_at)
    .map((entry) => {
      const options = entry.options.map((option) => ({
        code: option.code,
        label: option.label,
        date: option.date,
        window: option.window,
      }));
      return {
        call_id: entry.call_id,
        vendor_uuid: entry.vendor_uuid,
        job_uuid: entry.job_uuid,
        valid_codes: options.map((option) => option.code),
        options,
        expires_at: new Date(entry.expires_at).toISOString(),
        ttl_seconds: Math.max(0, Math.floor((entry.expires_at - now) / 1000)),
      };
    });
};
