import { spawn } from "child_process";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const token = process.env.VAPI_BEARER_TOKEN;

if (!token) {
  console.error("Missing VAPI_BEARER_TOKEN");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${baseUrl}${path}`, init);
  const json = await res.json();
  return { status: res.status, json };
};

const waitForHealth = async (timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetchJson("/health");
      if (res.status === 200 && res.json?.ok) {
        return true;
      }
    } catch {
      // ignore
    }
    await sleep(500);
  }
  return false;
};

const run = async () => {
  let child: ReturnType<typeof spawn> | null = null;
  const alreadyRunning = await waitForHealth(1000);
  if (!alreadyRunning) {
    child = spawn("npm", ["run", "start"], {
      env: { ...process.env, PORT: "3000" },
      stdio: "inherit",
    });
    const ready = await waitForHealth(15000);
    if (!ready) {
      console.error("FAIL - server did not start");
      child.kill("SIGTERM");
      process.exit(1);
    }
  }

  const health = await fetchJson("/health");
  const ping = await fetchJson("/vapi/ping", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

  const ok = health.status === 200 && health.json?.ok && ping.status === 200 && ping.json?.ok;
  if (ok) {
    console.log("PASS - local smoke");
  } else {
    console.error("FAIL - local smoke", { health, ping });
  }

  if (child) {
    child.kill("SIGTERM");
  }
  process.exit(ok ? 0 : 1);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
