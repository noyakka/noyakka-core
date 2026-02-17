import { getServiceM8Client } from "../src/lib/servicem8-oauth";

type HarnessConfig = {
  baseUrl: string;
  vapiToken: string;
  vendorUuid: string;
  firstName: string;
  lastName: string;
  mobile: string;
  jobAddress: string;
  jobDescription: string;
  urgency: "emergency" | "today" | "this_week" | "next_week" | "quote_only";
};

const readConfig = (): HarnessConfig => {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const vapiToken = process.env.VAPI_BEARER_TOKEN || "";
  const vendorUuid = process.env.SERVICEM8_VENDOR_UUID || "";
  if (!vapiToken || !vendorUuid) {
    throw new Error("VAPI_BEARER_TOKEN and SERVICEM8_VENDOR_UUID are required");
  }
  return {
    baseUrl,
    vapiToken,
    vendorUuid,
    firstName: process.env.HARNESS_FIRST_NAME || "Harness",
    lastName: process.env.HARNESS_LAST_NAME || "Tester",
    mobile: process.env.HARNESS_MOBILE || "0400000000",
    jobAddress: process.env.HARNESS_JOB_ADDRESS || "1 Test Street, Mount Ommaney",
    jobDescription: process.env.HARNESS_JOB_DESCRIPTION || "No power in kitchen area",
    urgency: (process.env.HARNESS_URGENCY as HarnessConfig["urgency"]) || "this_week",
  };
};

const postJson = async (url: string, token: string, body: unknown) => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

const requireOk = (label: string, response: { status: number; json: any }) => {
  if (!response.json?.ok) {
    throw new Error(`${label} failed (${response.status}): ${JSON.stringify(response.json)}`);
  }
};

const main = async () => {
  const cfg = readConfig();
  const callId = `harness-${Date.now()}`;

  console.log("1) createJob");
  const createRes = await postJson(`${cfg.baseUrl}/vapi/create-job`, cfg.vapiToken, {
    call_id: callId,
    servicem8_vendor_uuid: cfg.vendorUuid,
    first_name: cfg.firstName,
    last_name: cfg.lastName,
    mobile: cfg.mobile,
    job_address: cfg.jobAddress,
    job_description: cfg.jobDescription,
    urgency: cfg.urgency,
  });
  requireOk("createJob", createRes);
  const jobUuid = String(createRes.json.job_uuid || "");
  if (!jobUuid) {
    throw new Error(`createJob returned no job_uuid: ${JSON.stringify(createRes.json)}`);
  }
  console.log(`   job_uuid=${jobUuid}`);

  console.log("2) verify profit note exists");
  const sm8 = await getServiceM8Client(cfg.vendorUuid);
  const activity = await sm8.getJson(`/jobactivity.json?job_uuid=${encodeURIComponent(jobUuid)}`);
  const notes = Array.isArray(activity?.data) ? activity.data : [];
  const profitNote = notes.find((item: any) => String(item?.note || "").includes("NOYAKKA PROFIT INSIGHT"));
  if (!profitNote) {
    throw new Error("Profit insight note not found on job activity");
  }
  const profitText = String(profitNote.note || "");
  const hasRequiredFields =
    profitText.includes("jobType:") &&
    profitText.includes("estDurationMins:") &&
    profitText.includes("estValue:") &&
    profitText.includes("marginFlag:");
  if (!hasRequiredFields) {
    throw new Error("Profit note missing required fields");
  }
  console.log("   profit note found with required fields");

  console.log("3) getAvailability returns structured codes");
  const availRes = await postJson(`${cfg.baseUrl}/vapi/get-availability`, cfg.vapiToken, {
    call_id: callId,
    servicem8_vendor_uuid: cfg.vendorUuid,
    job_uuid: jobUuid,
    urgency: cfg.urgency === "quote_only" ? "this_week" : cfg.urgency,
  });
  requireOk("getAvailability", availRes);
  const options = Array.isArray(availRes.json.options) ? availRes.json.options : [];
  if (options.length === 0) {
    throw new Error("getAvailability returned no options");
  }
  const first = options[0];
  if (!first?.code || !first?.label || !first?.date || !first?.window) {
    throw new Error(`getAvailability option missing required keys: ${JSON.stringify(first)}`);
  }
  console.log(`   selected_code=${first.code}`);

  console.log("4) bookWindow with returned selected_code");
  const bookRes = await postJson(`${cfg.baseUrl}/vapi/booking/book-window`, cfg.vapiToken, {
    call_id: callId,
    servicem8_vendor_uuid: cfg.vendorUuid,
    job_uuid: jobUuid,
    selected_code: first.code,
  });
  requireOk("bookWindow", bookRes);
  const allocationUuid = String(bookRes.json.allocation_uuid || "");
  if (!allocationUuid) {
    throw new Error(`bookWindow returned no allocation_uuid: ${JSON.stringify(bookRes.json)}`);
  }
  console.log(`   allocation_uuid=${allocationUuid}`);

  console.log("5) verify allocation renders-ready fields");
  const allocRes = await sm8.getJson(`/joballocation/${allocationUuid}.json`);
  const allocation = allocRes?.data || {};
  const hasDispatchFields =
    !!allocation.staff_uuid &&
    !!allocation.allocation_date &&
    !!allocation.start_time &&
    !!allocation.end_time;
  if (!hasDispatchFields) {
    throw new Error(`Allocation missing dispatch fields: ${JSON.stringify(allocation)}`);
  }
  console.log("   allocation has staff_uuid + allocation_date + start_time + end_time");

  console.log("\nHarness complete: createJob -> profit note -> availability codes -> booking allocation.");
};

main().catch((err) => {
  console.error("Harness failed:", err?.message || err);
  process.exit(1);
});
