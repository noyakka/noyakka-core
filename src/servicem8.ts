import axios from "axios";

export function createServiceM8Client(env: {
  SERVICEM8_BASE_URL: string;
  SERVICEM8_API_KEY: string;
}) {
  return axios.create({
    baseURL: env.SERVICEM8_BASE_URL,
    headers: {
      "X-API-Key": env.SERVICEM8_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 10000,
  });
}
