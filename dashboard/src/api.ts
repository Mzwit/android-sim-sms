/** Thin client for the backend API. Uses the HttpOnly session cookie (same origin). */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

let onUnauthenticated: (() => void) | undefined;
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

export async function api<T = any>(method: Method, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-smsgw-csrf': '1' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 401 && path !== '/auth/login') onUnauthenticated?.();
    throw new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message ?? res.statusText, err.details);
  }
  return data as T;
}

function safeJson(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t };
  }
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b?: unknown, h?: Record<string, string>) => api<T>('POST', p, b ?? {}, h);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

/** Download a CSV (or any file) from an authenticated GET endpoint. */
export async function download(path: string, fallbackName: string) {
  const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, 'DOWNLOAD_FAILED', `Download failed (${res.status})`);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] ?? fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (Array.isArray(e.details) && e.details.length && typeof e.details[0] === 'string') return `${e.message}: ${(e.details as string[]).join('; ')}`;
    if (e.code === 'VALIDATION_FAILED' && Array.isArray(e.details)) {
      return 'Check the form: ' + (e.details as { path?: string; message?: string }[]).map((d) => `${(d.path ?? '').replace(/^\//, '')} ${d.message ?? ''}`.trim()).join('; ');
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

export function uuid(): string {
  return crypto.randomUUID();
}
