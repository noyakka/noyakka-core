type Env = {
  baseUrl: string;
  accessToken?: string;
  apiKey?: string;
};

function authHeaders(env: Env) {
  if (env.apiKey) {
    return { "X-API-Key": env.apiKey };
  }
  return { Authorization: `Bearer ${env.accessToken}` };
}

export function createServiceM8Client(env: Env) {
  const jsonHeaders = () => ({
    ...authHeaders(env),
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  async function postJson(path: string, body: unknown) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: jsonHeaders(),
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
    return { data, recordUuid, status: res.status };
  }

  async function getJson(path: string) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { ...authHeaders(env), Accept: "application/json" },
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

  async function deleteJson(path: string) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { ...authHeaders(env), Accept: "application/json" },
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

  async function putJson(path: string, body: unknown) {
    const url = `${env.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: jsonHeaders(),
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

    return { data, status: res.status };
  }

  return { postJson, getJson, deleteJson, putJson };
}
