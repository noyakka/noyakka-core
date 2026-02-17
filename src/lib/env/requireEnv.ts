type RequireEnvResult =
  | { ok: true; values: Record<string, string> }
  | {
      ok: false;
      response: {
        ok: false;
        error_code: "MISSING_ENV";
        message: string;
        missing_keys: string[];
      };
    };

export const requireEnv = (
  keys: string[],
  ctx: { endpoint: string; request_id?: string; call_id?: string }
): RequireEnvResult => {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    return {
      ok: false,
      response: {
        ok: false,
        error_code: "MISSING_ENV",
        message: `Missing env: ${missing.join(", ")}`,
        missing_keys: missing,
      },
    };
  }

  const values: Record<string, string> = {};
  for (const key of keys) {
    values[key] = process.env[key] as string;
  }
  return { ok: true, values };
};

export const requireServiceM8Env = (ctx: { endpoint: string; request_id?: string; call_id?: string }) =>
  requireEnv(["SERVICEM8_APP_ID", "SERVICEM8_APP_SECRET"], ctx);

export const requireVapiEnv = (ctx: { endpoint: string; request_id?: string; call_id?: string }) =>
  requireEnv(["VAPI_BEARER_TOKEN"], ctx);
