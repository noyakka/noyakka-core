import { describe, expect, it } from "vitest";
import { normalizeUrgency, normalizeVapiArgs, normalizeWindow } from "../normalize";

describe("normalizeUrgency", () => {
  it("normalizes known urgency variants", () => {
    expect(normalizeUrgency("this week")).toBe("this_week");
    expect(normalizeUrgency("nextweek")).toBe("next_week");
    expect(normalizeUrgency("quote only")).toBe("quote_only");
    expect(normalizeUrgency("urgent")).toBe("emergency");
  });

  it("returns null for unknown urgency", () => {
    expect(normalizeUrgency("sometime")).toBeNull();
  });
});

describe("normalizeWindow", () => {
  it("normalizes window variants", () => {
    expect(normalizeWindow("am")).toBe("morning");
    expect(normalizeWindow("pm")).toBe("arvo");
    expect(normalizeWindow("afternoon")).toBe("arvo");
  });

  it("returns null for unknown window", () => {
    expect(normalizeWindow("evening")).toBeNull();
  });
});

describe("normalizeVapiArgs", () => {
  it("normalizes fields from extracted args + meta", () => {
    const extracted = {
      args: {
        servicem8_vendor_uuid: "vendor_1",
        urgency: "this week",
        window: "pm",
        date: "2026-01-02",
        first_name: "Zac",
        mobile: "0425278961",
        job_address: "128 Example St, Westlake",
        job_description: "New port",
      },
      meta: { call_id: "call_123" },
    };
    const result = normalizeVapiArgs(extracted);
    expect(result).toMatchObject({
      vendor_uuid: "vendor_1",
      call_id: "call_123",
      urgency: "this_week",
      window: "arvo",
      date: "2026-01-02",
      first_name: "Zac",
      mobile: "0425278961",
      job_description: "New port",
    });
    expect(result.address?.full).toBe("128 Example St, Westlake");
  });
});
