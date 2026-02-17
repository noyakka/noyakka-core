const baseUrl = (process.env.VAPI_BASE_URL || "https://noyakka-core.fly.dev").replace(/\/+$/, "");
const token = process.env.VAPI_BEARER_TOKEN;
const vendorUuid = process.env.SERVICEM8_VENDOR_UUID || process.env.SERVICEM8_COMPANY_UUID;

if (!token) {
  console.error("Missing VAPI_BEARER_TOKEN");
  process.exit(1);
}
if (!vendorUuid) {
  console.error("Missing SERVICEM8_VENDOR_UUID (or SERVICEM8_COMPANY_UUID)");
  process.exit(1);
}

const postJson = async (path: string, body: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!text || text.trim().length === 0) {
    throw new Error(`${path} returned empty response body`);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} returned non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!json || typeof json !== "object") {
    throw new Error(`${path} returned invalid JSON object`);
  }
  return { status: res.status, json, text };
};

const run = async () => {
  const createJobPayload = {
    servicem8_vendor_uuid: vendorUuid,
    mobile: "0400000000",
    urgency: "this_week",
    job_address: "1 Example Street, Westlake",
    job_description: "Contract test",
    first_name: "Contract",
  };
  const availabilityPayload = {
    servicem8_vendor_uuid: vendorUuid,
    urgency: "this_week",
  };

  const createJob = await postJson("/vapi/create-job", createJobPayload);
  if (createJob.json.ok !== true || typeof createJob.json.job_uuid !== "string" || typeof createJob.json.job_number !== "string") {
    throw new Error(`create-job contract failed: ${JSON.stringify(createJob.json)}`);
  }
  console.log(`PASS create-job status=${createJob.status} ok=${createJob.json.ok}`);

  const availability = await postJson("/vapi/get-availability", availabilityPayload);
  if (!Array.isArray(availability.json.options) || availability.json.options.length === 0) {
    throw new Error(`get-availability returned no options: ${JSON.stringify(availability.json)}`);
  }
  const invalidOption = availability.json.options.find(
    (option: any) =>
      !option ||
      typeof option.code !== "string" ||
      typeof option.label !== "string" ||
      typeof option.date !== "string" ||
      (option.window !== "morning" && option.window !== "arvo") ||
      typeof option.start !== "string" ||
      typeof option.end !== "string"
  );
  if (invalidOption) {
    throw new Error(`get-availability option shape invalid: ${JSON.stringify(invalidOption)}`);
  }
  const optionsCount = Array.isArray(availability.json.options) ? availability.json.options.length : 0;
  console.log(
    `PASS get-availability status=${availability.status} ok=${availability.json.ok} options=${optionsCount}`
  );
};

run().catch((err) => {
  console.error(`FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
