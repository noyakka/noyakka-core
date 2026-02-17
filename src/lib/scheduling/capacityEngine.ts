export type SchedulingWindow = "morning" | "afternoon";

export type StaffInput = {
  uuid: string;
  work_start?: string;
  work_end?: string;
};

export type ExistingAllocation = {
  staff_uuid: string;
  window?: SchedulingWindow;
  start_time?: string;
  end_time?: string;
  effective_minutes?: number;
};

export type CapacityEngineInput = {
  staff: StaffInput[];
  allocations: ExistingAllocation[];
  window: SchedulingWindow;
  job_duration_minutes: number;
  max_jobs_per_window?: number;
  buffer_ratio?: number;
};

export type StaffWindowUsage = {
  staff_uuid: string;
  jobs_count: number;
  used_minutes: number;
  eligible: boolean;
  next_start_time?: string;
  next_end_time?: string;
};

export type CapacityEngineResult = {
  effective_minutes: number;
  selected_staff_uuid?: string;
  start_time?: string;
  end_time?: string;
  window_full: boolean;
  staff_usage: StaffWindowUsage[];
};

const WINDOW_BOUNDS: Record<SchedulingWindow, { start: number; end: number }> = {
  morning: { start: 8 * 60, end: 12 * 60 },
  afternoon: { start: 12 * 60, end: 17 * 60 },
};

const parseClockToMinutes = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return fallback;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return fallback;
  }
  return hours * 60 + minutes;
};

const toClock = (minutes: number) => {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = Math.floor(minutes % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}`;
};

const computeEffectiveMinutes = (jobDurationMinutes: number, bufferRatio: number) => {
  const buffer = Math.ceil(jobDurationMinutes * bufferRatio);
  return jobDurationMinutes + buffer;
};

const normalizeAllocations = (
  allocations: ExistingAllocation[],
  window: SchedulingWindow,
  defaultEffectiveMinutes: number
) => {
  return allocations
    .filter((allocation) => allocation.window === window)
    .map((allocation) => {
      const start = parseClockToMinutes(allocation.start_time, WINDOW_BOUNDS[window].start);
      const end =
        allocation.end_time != null
          ? parseClockToMinutes(allocation.end_time, start + defaultEffectiveMinutes)
          : start + (allocation.effective_minutes ?? defaultEffectiveMinutes);
      return {
        staff_uuid: allocation.staff_uuid,
        start,
        end,
      };
    })
    .sort((a, b) => a.start - b.start);
};

const findEarliestSlot = (input: {
  existing: Array<{ start: number; end: number }>;
  windowStart: number;
  windowEnd: number;
  staffStart: number;
  staffEnd: number;
  requiredMinutes: number;
}) => {
  const startBound = Math.max(input.windowStart, input.staffStart);
  const endBound = Math.min(input.windowEnd, input.staffEnd);
  if (endBound - startBound < input.requiredMinutes) {
    return null;
  }
  let cursor = startBound;
  for (const alloc of input.existing) {
    const blockStart = Math.max(startBound, alloc.start);
    const blockEnd = Math.min(endBound, alloc.end);
    if (blockEnd <= blockStart) {
      continue;
    }
    if (blockStart - cursor >= input.requiredMinutes) {
      return { start: cursor, end: cursor + input.requiredMinutes };
    }
    cursor = Math.max(cursor, blockEnd);
  }
  if (endBound - cursor >= input.requiredMinutes) {
    return { start: cursor, end: cursor + input.requiredMinutes };
  }
  return null;
};

export const runCapacityEngine = (input: CapacityEngineInput): CapacityEngineResult => {
  const maxJobsPerWindow = input.max_jobs_per_window ?? 2;
  const bufferRatio = input.buffer_ratio ?? 0.2;
  const effectiveMinutes = computeEffectiveMinutes(input.job_duration_minutes, bufferRatio);
  const windowBounds = WINDOW_BOUNDS[input.window];
  const normalized = normalizeAllocations(input.allocations, input.window, effectiveMinutes);

  const staffUsage: StaffWindowUsage[] = input.staff.map((staff) => {
    const staffStart = parseClockToMinutes(staff.work_start, 8 * 60);
    const staffEnd = parseClockToMinutes(staff.work_end, 17 * 60);
    const existing = normalized.filter((allocation) => allocation.staff_uuid === staff.uuid);
    const jobsCount = existing.length;
    const usedMinutes = existing.reduce((sum, allocation) => {
      const clippedStart = Math.max(windowBounds.start, allocation.start);
      const clippedEnd = Math.min(windowBounds.end, allocation.end);
      return sum + Math.max(0, clippedEnd - clippedStart);
    }, 0);

    const slot = findEarliestSlot({
      existing,
      windowStart: windowBounds.start,
      windowEnd: windowBounds.end,
      staffStart,
      staffEnd,
      requiredMinutes: effectiveMinutes,
    });
    const windowLimit = windowBounds.end - windowBounds.start;
    const eligible =
      jobsCount < maxJobsPerWindow &&
      usedMinutes + effectiveMinutes <= windowLimit &&
      slot !== null;

    return {
      staff_uuid: staff.uuid,
      jobs_count: jobsCount,
      used_minutes: usedMinutes,
      eligible,
      next_start_time: slot ? toClock(slot.start) : undefined,
      next_end_time: slot ? toClock(slot.end) : undefined,
    };
  });

  const eligibleStaff = staffUsage
    .filter((usage) => usage.eligible && usage.next_start_time && usage.next_end_time)
    .sort((a, b) => {
      if (a.used_minutes !== b.used_minutes) {
        return a.used_minutes - b.used_minutes;
      }
      return (a.next_start_time || "").localeCompare(b.next_start_time || "");
    });

  if (eligibleStaff.length === 0) {
    return {
      effective_minutes: effectiveMinutes,
      window_full: true,
      staff_usage: staffUsage,
    };
  }

  const selected = eligibleStaff[0];
  return {
    effective_minutes: effectiveMinutes,
    selected_staff_uuid: selected.staff_uuid,
    start_time: selected.next_start_time,
    end_time: selected.next_end_time,
    window_full: false,
    staff_usage: staffUsage,
  };
};
