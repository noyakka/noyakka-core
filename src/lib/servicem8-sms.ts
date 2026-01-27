import { getServiceM8AccessToken } from "./servicem8-oauth";

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
  const accessToken = await getServiceM8AccessToken(companyUuid);

  const res = await fetch(`${BASE_URL}/platform_service_sms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: toMobile,
      message,
      ...(regardingJobUuid ? { regardingJobUUID: regardingJobUuid } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    const err: any = new Error("ServiceM8 SMS failed");
    err.status = res.status;
    err.data = text;
    throw err;
  }
};
