type Env = {
  SERVICEM8_BASE_URL: string;
  SERVICEM8_API_KEY: string;
};

export function createServiceM8Client(env: Env) {
  async function postJson(path: string, body: unknown) {
    const url = `${env.SERVICEM8_BASE_URL}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        // Use ServiceM8's documented header name
        "X-Api-Key": env.SERVICEM8_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const err: any = new Error("ServiceM8 request failed");
      err.status = res.status;
      err.data = data;
      throw err;
    }

    // ServiceM8 often returns created UUID in x-record-uuid header for create endpoints
    const recordUuid = res.headers.get("x-record-uuid");
    return { data, recordUuid };
  }

  return { postJson };
}
