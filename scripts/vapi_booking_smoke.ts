const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const token = process.env.VAPI_BEARER_TOKEN;
const enable = process.env.ENABLE_SERVICEM8_SMOKE === "true";

if (!token) {
  console.error("Missing VAPI_BEARER_TOKEN");
  process.exit(1);
}

const vendor_uuid = process.env.SERVICEM8_VENDOR_UUID || "vendor_dummy";
const job_uuid = process.env.TEST_JOB_UUID || "job_dummy";
const debugKey = process.env.DEBUG_KEY;
const urgency = "next week";

const postJson = async (path: string, body: unknown) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
};

const getDebug = async (path: string) => {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: debugKey ? { "X-DEBUG-KEY": debugKey } : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
};

const run = async () => {
  if (!enable) {
    const dryRun = await postJson("/vapi/booking/book-window", {
      servicem8_vendor_uuid: vendor_uuid,
      call_id: `dry_${Date.now()}`,
      job_uuid,
      date: "2099-12-31",
      window: "arvo",
      allocation_window_uuid: "allocation_dummy",
      dry_run: true,
    });
    if (dryRun.json?.ok) {
      console.log("PASS dry-run booking validation");
      process.exit(0);
    }
    console.error("FAIL dry-run booking validation", dryRun.json);
    process.exit(1);
  }

  if (!process.env.SERVICEM8_VENDOR_UUID) {
    console.error("FAIL error_code=MISSING_VENDOR_UUID");
    process.exit(1);
  }

  const windows = await postJson("/vapi/availability/windows", {
    servicem8_vendor_uuid: vendor_uuid,
    urgency,
  });
  const options = Array.isArray(windows.json?.options) ? windows.json.options : [];
  const dateRange =
    options.length > 0
      ? `${options[0].date}..${options[options.length - 1].date}`
      : "none";
  console.log(
    `availability vendor_uuid=${vendor_uuid} urgency=${urgency} range=${dateRange} windows=${options.length}`
  );
  if (!windows.json?.ok || !Array.isArray(windows.json?.options) || windows.json.options.length === 0) {
    let reason = "NO_WINDOWS";
    let details = "";
    if (debugKey) {
      const debug = await getDebug("/debug/last-availability-errors");
      const entry = Array.isArray(debug.json?.errors) ? debug.json.errors[0] : null;
      if (entry) {
        reason = entry.reason_code || reason;
        details = entry.details ? JSON.stringify(entry.details) : "";
      }
    }
    console.error(
      `FAIL error_code=NO_WINDOWS reason=${reason} status=${windows.status} ${details}`.trim()
    );
    process.exit(1);
  }

  console.log(`availability_windows=${JSON.stringify(options)}`);
  const option = options.find((opt: any) => opt.window === "arvo") || options[0];
  const payload = await postJson("/vapi/booking/book-window", {
    servicem8_vendor_uuid: vendor_uuid,
    call_id: `smoke_${Date.now()}`,
    job_uuid,
    date: option.date,
    window: "arvo",
    allocation_window_uuid: option.allocation_window_uuid,
    first_name: "Smoke",
    last_name: "Test",
    mobile: "+61400000000",
    address: { street_number: "1", street_name: "Test St", suburb: "Brisbane" },
    job_description: "Booking smoke test",
  });

  if (payload.json?.ok) {
    console.log(
      `PASS booked allocation_uuid=${payload.json.allocation_uuid} job_uuid=${job_uuid} sms_sent=${payload.json.sms_sent ?? false}`
    );
    process.exit(0);
  }

  const errorCode = payload.json?.error_code || "UNKNOWN";
  const servicem8Status = payload.json?.servicem8_status ?? "";
  console.error(
    `FAIL error_code=${errorCode} status=${payload.status} servicem8_status=${servicem8Status}`
  );
  process.exit(1);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
