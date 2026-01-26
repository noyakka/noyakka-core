import axios from "axios";

export function createServiceM8Client(env: {
  SERVICEM8_BASE_URL: string;
  SERVICEM8_EMAIL: string;
  SERVICEM8_PASSWORD: string;
}) {
  return axios.create({
    baseURL: env.SERVICEM8_BASE_URL,
    auth: {
      username: env.SERVICEM8_EMAIL,
      password: env.SERVICEM8_PASSWORD,
    },
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    timeout: 10000,
  });
}
