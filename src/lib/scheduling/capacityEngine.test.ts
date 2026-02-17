import { describe, expect, it } from "vitest";
import { runCapacityEngine } from "./capacityEngine";

describe("runCapacityEngine", () => {
  it("calculates effective minutes and selects least used staff", () => {
    const result = runCapacityEngine({
      staff: [{ uuid: "staff_a" }, { uuid: "staff_b" }],
      allocations: [
        {
          staff_uuid: "staff_a",
          window: "morning",
          start_time: "08:00",
          end_time: "10:00",
        },
      ],
      window: "morning",
      job_duration_minutes: 100,
      max_jobs_per_window: 2,
      buffer_ratio: 0.2,
    });

    expect(result.effective_minutes).toBe(120);
    expect(result.window_full).toBe(false);
    expect(result.selected_staff_uuid).toBe("staff_b");
    expect(result.start_time).toBe("08:00");
    expect(result.end_time).toBe("10:00");
  });

  it("falls back to next internal slot when early slot is taken", () => {
    const result = runCapacityEngine({
      staff: [{ uuid: "staff_a" }],
      allocations: [
        {
          staff_uuid: "staff_a",
          window: "afternoon",
          start_time: "12:00",
          end_time: "13:30",
        },
      ],
      window: "afternoon",
      job_duration_minutes: 60,
      max_jobs_per_window: 3,
      buffer_ratio: 0.2,
    });

    expect(result.window_full).toBe(false);
    expect(result.selected_staff_uuid).toBe("staff_a");
    expect(result.start_time).toBe("13:30");
    expect(result.end_time).toBe("14:42");
  });

  it("returns window full when all staff exceed job limit", () => {
    const result = runCapacityEngine({
      staff: [{ uuid: "staff_a" }],
      allocations: [
        { staff_uuid: "staff_a", window: "morning", start_time: "08:00", end_time: "09:00" },
        { staff_uuid: "staff_a", window: "morning", start_time: "09:30", end_time: "10:30" },
      ],
      window: "morning",
      job_duration_minutes: 60,
      max_jobs_per_window: 2,
      buffer_ratio: 0.2,
    });

    expect(result.window_full).toBe(true);
    expect(result.selected_staff_uuid).toBeUndefined();
  });
});
