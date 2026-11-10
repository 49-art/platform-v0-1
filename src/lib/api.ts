/** One way to talk to the Worker. Sends the CSRF header the server expects on every state-changing call. */

export interface ApiError {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
  sample?: SampleLink;
  [key: string]: unknown;
}
export interface SampleLink {
  link: string;
  note: string;
}

export class ApiFailure extends Error {
  constructor(public status: number, public error: ApiError) {
    super(error.message);
  }
}

function csrf(): string {
  const m = /(?:^|;\s*)__Host-csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : "";
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (method !== "GET") headers["x-csrf-token"] = csrf();
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  } catch {
    throw new ApiFailure(0, { code: "offline", message: "You appear to be offline. Check your connection and try again." });
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const err: ApiError = data?.error ?? { code: "http_" + res.status, message: res.status >= 500 ? "Something went wrong on our side. Try again in a moment." : "That did not work." };
    throw new ApiFailure(res.status, err);
  }
  return data as T;
}

export const get = <T = any>(path: string) => api<T>("GET", path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const put = <T = any>(path: string, body: unknown = {}) => api<T>("PUT", path, body);
export const del = <T = any>(path: string) => api<T>("DELETE", path);

export function messageOf(err: unknown): string {
  if (err instanceof ApiFailure) {
    const fields = err.error.fields ? Object.values(err.error.fields).flat().filter(Boolean) : [];
    return fields.length ? `${err.error.message} ${fields.join(" ")}` : err.error.message;
  }
  return "Something went wrong. Try again.";
}

export const when = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "";
export const ago = (ms: number | null | undefined) => {
  if (!ms) return "";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};
