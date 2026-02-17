#!/usr/bin/env npx tsx
/**
 * Verifies the server is running before starting ServiceM8 OAuth.
 * Run this to avoid "Error -102 connection refused" when the callback redirects.
 *
 * Usage: npm run oauth:check
 * Or:    npx tsx scripts/oauth_check.ts
 */
const baseUrl = process.env.BASE_URL || "http://localhost:3000";

async function check(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual" });
    return res.status === 200 || res.status === 302;
  } catch {
    return false;
  }
}

async function main() {
  const healthOk = await check(`${baseUrl.replace(/\/$/, "")}/health`);
  const startOk = await check(`${baseUrl.replace(/\/$/, "")}/auth/servicem8/start`);

  if (!healthOk) {
    console.error("FAIL: Server is not reachable at", baseUrl);
    console.error("");
    console.error("Fix: Start the server first:");
    console.error("  npm run dev");
    console.error("");
    console.error("Then run this check again before starting OAuth.");
    process.exit(1);
  }

  if (!startOk) {
    console.error("WARN: /auth/servicem8/start returned unexpected status");
    console.error("  (302 redirect is OK, 404 means routes not registered)");
  }

  console.log("OK: Server is running at", baseUrl);
  console.log("");
  console.log("OAuth flow:");
  console.log("  1. Keep the server running (npm run dev)");
  console.log("  2. Open this URL in the SAME browser on this computer:");
  console.log(`     ${baseUrl.replace(/\/$/, "")}/auth/servicem8/start`);
  console.log("  3. Do NOT start OAuth from a phone or different computer");
  console.log("  4. Complete ServiceM8 login and approval");
  console.log("  5. You should be redirected back to the callback successfully");
  console.log("");
  if (baseUrl.includes("localhost")) {
    console.log("Note: localhost only works when the browser is on this machine.");
    console.log("For phone/remote testing, use ngrok - see RUNBOOK.md");
  }
}

main();
