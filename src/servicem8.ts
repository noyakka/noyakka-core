type Env = {
  baseUrl: string;
  accessToken: string;
};

export function createServiceM8Client(env: Env) {
  async function postJson(path: string, body: unknown) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
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

  async function getJson(path: string) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.accessToken}`,
        "Accept": "application/json",
      },
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

    return { data };
  }

  return { postJson, getJson };
}
