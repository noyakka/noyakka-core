import { getServiceM8Auth } from "./servicem8-oauth";

type SendSmsInput = {
  companyUuid: string;
  toMobile: string;
  message: string;
  regardingJobUuid?: string;
};

const BASE_URL = "https://api.servicem8.com";

export const sendServiceM8Sms = async ({
  companyUuid,
  toMobile,
  message,
  regardingJobUuid,
}: SendSmsInput) => {
  const auth = await getServiceM8Auth(companyUuid);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (auth.apiKey) {
    headers["X-API-Key"] = auth.apiKey;
  } else if (auth.bearer) {
    headers["Authorization"] = `Bearer ${auth.bearer}`;
  }

  const res = await fetch(`${BASE_URL}/platform_service_sms`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: toMobile,
      message,
      ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    const err: any = new Error("ServiceM8 SMS failed");
    err.status = res.status;
    err.data = text;
    throw err;
  }

  return { status: res.status, body: text };
};
