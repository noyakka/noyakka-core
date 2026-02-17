const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const token = process.env.VAPI_BEARER_TOKEN;

if (!token) {
  console.error("Missing VAPI_BEARER_TOKEN");
  process.exit(1);
}

type TestResult = { name: string; ok: boolean; details?: string };

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

const run = async () => {
  const results: TestResult[] = [];

  const wrappedPayload = {
    toolCall: {
      id: "call_test_1",
      function: { name: "check-availability" },
      args: { urgency: "this week" },
    },
  };
  const res1 = await postJson("/vapi/check-availability", wrappedPayload);
  results.push({
    name: "wrapped payload normalizes urgency",
    ok: res1.status === 200 && res1.json.ok === true && res1.json.window === "this_week",
    details: JSON.stringify(res1.json),
  });

  const res2 = await postJson("/vapi/check-availability", { urgency: "whenever" });
  results.push({
    name: "invalid urgency returns INVALID_URGENCY",
    ok: res2.status === 200 && res2.json.ok === false && res2.json.error_code === "INVALID_URGENCY",
    details: JSON.stringify(res2.json),
  });

  const res4 = await postJson("/vapi/create-lead", {
    call_id: "call_missing_mobile",
    company_uuid: "vendor_demo",
    first_name: "Zac",
    last_name: "Tester",
    job_description: "Test job",
    address: {
      street_number: "1",
      street_name: "Example St",
      suburb: "Brisbane",
    },
    urgency: "this week",
  });
  results.push({
    name: "create-lead missing mobile",
    ok: res4.status === 200 && res4.json.ok === false && res4.json.error_code === "VALIDATION_ERROR",
    details: JSON.stringify(res4.json),
  });

  const doubleWrapped = {
    arguments:
      "{\"args\":{\"arguments\":\"{\\\"urgency\\\":\\\"this week\\\"}\"}}",
  };
  const res5 = await postJson("/vapi/check-availability", doubleWrapped);
  results.push({
    name: "double-wrapped JSON arguments parsed",
    ok: res5.status === 200 && res5.json.ok === true && res5.json.window === "this_week",
    details: JSON.stringify(res5.json),
  });

  if (process.env.RUN_EXTERNAL_TESTS === "1") {
    const res3 = await postJson("/vapi/create-lead", {
      call_id: "call_external_lead",
      company_uuid: "vendor_demo",
      first_name: "Zac",
      last_name: "Tester",
      mobile: "+61412345678",
      job_description: "External test lead",
      address: {
        street_number: "1",
        street_name: "Example St",
        suburb: "Brisbane",
      },
      urgency: "this week",
    });
    results.push({
      name: "create-lead with company_uuid only",
      ok: res3.status === 200 && res3.json.ok === true,
      details: JSON.stringify(res3.json),
    });
  } else {
    results.push({
      name: "create-lead with company_uuid only (skipped)",
      ok: true,
      details: "Set RUN_EXTERNAL_TESTS=1 to run",
    });
  }

  const failed = results.filter((r) => !r.ok);
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`${status} - ${result.name}`);
    if (!result.ok && result.details) {
      console.log(`  ${result.details}`);
    }
  }

  if (failed.length > 0) {
    process.exit(1);
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
