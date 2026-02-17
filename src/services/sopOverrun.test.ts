import { describe, expect, it } from "vitest";
import { findNextAllocation, getEstimatedEnd, parseServiceM8DateTime } from "./sopOverrun";

describe("sopOverrun helpers", () => {
  it("parses ServiceM8 datetime values safely", () => {
    expect(parseServiceM8DateTime("2026-02-16 10:30:00")).not.toBeNull();
    expect(parseServiceM8DateTime("0000-00-00 00:00:00")).toBeNull();
    expect(parseServiceM8DateTime("")).toBeNull();
  });

  it("derives estimated end from allocation date and end time", () => {
    const end = getEstimatedEnd({
      allocation_date: "2026-02-16",
      end_time: "12:00",
    });
    expect(end).not.toBeNull();
    expect(end?.toISOString()).toContain("2026-02-16");
  });

  it("finds the next uncompleted job for same staff/day", () => {
    const allocations = [
      {
        uuid: "a1",
        staff_uuid: "staff-1",
        allocation_date: "2026-02-16",
        start_time: "08:00",
        end_time: "10:00",
        completion_timestamp: "",
      },
      {
        uuid: "a2",
        staff_uuid: "staff-1",
        allocation_date: "2026-02-16",
        start_time: "11:00",
        end_time: "12:00",
        completion_timestamp: "",
      },
      {
        uuid: "a3",
        staff_uuid: "staff-1",
        allocation_date: "2026-02-16",
        start_time: "13:00",
        end_time: "14:00",
        completion_timestamp: "2026-02-16 13:30:00",
      },
    ];
    const next = findNextAllocation(allocations, allocations[0]);
    expect(next?.uuid).toBe("a2");
  });
});
