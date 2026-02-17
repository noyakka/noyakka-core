import type { ExistingAllocation, SchedulingWindow, StaffInput } from "./capacityEngine";

const toLower = (value: unknown) => String(value ?? "").toLowerCase();

const parseWindowFromTimes = (startTime: string | undefined): SchedulingWindow | undefined => {
  if (!startTime) {
    return undefined;
  }
  const match = String(startTime).match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  if (!Number.isFinite(hours)) {
    return undefined;
  }
  return hours < 12 ? "morning" : "afternoon";
};

export const isSchedulingV2Enabled = () => {
  return String(process.env.SCHEDULING_V2 || "false").toLowerCase() === "true";
};

export const getSchedulingV2Config = () => {
  const maxJobs = Number(process.env.SCHEDULING_V2_MAX_JOBS_PER_WINDOW || "2");
  const duration = Number(process.env.SCHEDULING_V2_DEFAULT_DURATION_MINUTES || "120");
  const bufferRatio = Number(process.env.SCHEDULING_V2_BUFFER_RATIO || "0.2");
  return {
    maxJobsPerWindow: Number.isFinite(maxJobs) ? maxJobs : 2,
    defaultJobDurationMinutes: Number.isFinite(duration) ? duration : 120,
    bufferRatio: Number.isFinite(bufferRatio) ? bufferRatio : 0.2,
  };
};

export const mapServiceM8Staff = (input: unknown): StaffInput[] => {
  const list = Array.isArray(input) ? input : [];
  return list
    .map((raw) => {
      const staff = (raw ?? {}) as Record<string, unknown>;
      const uuid = typeof staff.uuid === "string" ? staff.uuid : "";
      if (!uuid) {
        return null;
      }
      const active = toLower(staff.active || "1");
      if (!(active === "1" || active === "true")) {
        return null;
      }
      return {
        uuid,
        work_start:
          (typeof staff.work_start === "string" ? staff.work_start : undefined) ??
          (typeof staff.start_time === "string" ? staff.start_time : undefined),
        work_end:
          (typeof staff.work_end === "string" ? staff.work_end : undefined) ??
          (typeof staff.end_time === "string" ? staff.end_time : undefined),
      };
    })
    .filter((staff): staff is StaffInput => Boolean(staff));
};

export const mapServiceM8Allocations = (input: {
  allocationsRaw: unknown;
  date: string;
  morningWindowUuid?: string | null;
  arvoWindowUuid?: string | null;
}): ExistingAllocation[] => {
  const list = Array.isArray(input.allocationsRaw) ? input.allocationsRaw : [];
  return list
    .map((raw) => {
      const allocation = (raw ?? {}) as Record<string, unknown>;
      const staff_uuid = typeof allocation.staff_uuid === "string" ? allocation.staff_uuid : "";
      if (!staff_uuid) {
        return null;
      }
      const allocationDateRaw =
        typeof allocation.allocation_date === "string" ? allocation.allocation_date : "";
      if (!allocationDateRaw.startsWith(input.date)) {
        return null;
      }
      const windowUuid =
        typeof allocation.allocation_window_uuid === "string"
          ? allocation.allocation_window_uuid
          : undefined;
      const startTime = typeof allocation.start_time === "string" ? allocation.start_time : undefined;
      const endTime = typeof allocation.end_time === "string" ? allocation.end_time : undefined;

      let window: SchedulingWindow | undefined;
      if (windowUuid && input.morningWindowUuid && windowUuid === input.morningWindowUuid) {
        window = "morning";
      } else if (windowUuid && input.arvoWindowUuid && windowUuid === input.arvoWindowUuid) {
        window = "afternoon";
      } else {
        window = parseWindowFromTimes(startTime);
      }

      return {
        staff_uuid,
        window,
        start_time: startTime,
        end_time: endTime,
      };
    })
    .filter((allocation): allocation is ExistingAllocation => Boolean(allocation));
};

export const fetchAllocationsForDate = async (input: {
  sm8: { getJson: (path: string) => Promise<{ data: unknown }> };
  date: string;
}) => {
  const candidates = [
    `/joballocation.json?allocation_date=${encodeURIComponent(input.date)}`,
    `/joballocation.json?allocation_date=${encodeURIComponent(`${input.date} 00:00:00`)}`,
    "/joballocation.json",
  ];

  for (const path of candidates) {
    try {
      const res = await input.sm8.getJson(path);
      return Array.isArray(res?.data) ? res.data : [];
    } catch {
      // try next endpoint variant
    }
  }
  return [];
};
