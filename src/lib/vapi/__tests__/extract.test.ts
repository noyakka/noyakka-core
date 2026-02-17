import { describe, expect, it } from "vitest";
import { extractVapiArgs } from "../extract";

describe("extractVapiArgs", () => {
  it("returns raw args object when already provided", () => {
    const raw = { job_uuid: "abc", urgency: "today" };
    const result = extractVapiArgs(raw);
    expect(result.args).toEqual(raw);
    expect(result.meta).toEqual({});
  });

  it("unwraps args wrapper and parses JSON arguments", () => {
    const raw = { args: { arguments: "{\"job_uuid\":\"123\"}" } };
    const result = extractVapiArgs(raw);
    expect(result.args).toEqual({ job_uuid: "123" });
  });

  it("handles toolCall wrapper and captures meta", () => {
    const raw = {
      toolCall: {
        id: "call_1",
        function: { name: "create-job" },
        args: { mobile: "0412345678" },
      },
    };
    const result = extractVapiArgs(raw);
    expect(result.args).toEqual({ mobile: "0412345678" });
    expect(result.meta).toEqual({ call_id: "call_1", tool_name: "create-job" });
  });

  it("unwraps nested wrappers up to depth 3", () => {
    const raw = {
      input: {
        args: {
          arguments: "{\"job_description\":\"Fix switch\"}",
        },
      },
    };
    const result = extractVapiArgs(raw);
    expect(result.args).toEqual({ job_description: "Fix switch" });
  });
});
