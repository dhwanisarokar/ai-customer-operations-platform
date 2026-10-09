export type FieldErrors = Record<string, string>;

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; fieldErrors: FieldErrors };

type ErrorBody = {
  error?: {
    code?: string;
    message?: string;
    /** Zod issues, or `{ problems: string[] }` for definition validation (automations). */
    details?: { path: string; message: string }[] | { problems?: string[] };
  };
};

/**
 * A failed API call. `message` is always safe to show to a user (it is the server's safe message or
 * a generic fallback), `status` 0 means the request never reached the server.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly fieldErrors: FieldErrors = {},
    /** Human-readable validation problems (e.g. every issue in an automation definition). */
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Client errors (4xx) will not succeed if repeated unchanged. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

const GENERIC_MESSAGE = "Something went wrong. Please try again.";

/**
 * Typed `fetch` for our JSON API. Resolves with the parsed body (`null` for 204) and throws
 * `ApiError` for HTTP and network failures. Cookies are same-origin (the Clerk session). The
 * server remains the only authority for authorization; this layer only transports.
 */
export async function fetchJson<T>(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers:
        options.body === undefined && !options.headers
          ? undefined
          : {
              ...(options.body === undefined ? {} : { "content-type": "application/json" }),
              ...options.headers,
            },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error; // cancellation is not an application error
    throw new ApiError(0, "Network error. Please try again.", "network_error");
  }

  if (response.ok) {
    return (response.status === 204 ? null : await response.json()) as T;
  }

  const body = (await response.json().catch(() => null)) as ErrorBody | null;
  const fieldErrors: FieldErrors = {};
  const details = body?.error?.details;
  for (const detail of Array.isArray(details) ? details : []) {
    if (detail.path && !fieldErrors[detail.path]) fieldErrors[detail.path] = detail.message;
  }
  const problems =
    details && !Array.isArray(details) && Array.isArray(details.problems) ? details.problems : [];
  throw new ApiError(
    response.status,
    body?.error?.message ?? GENERIC_MESSAGE,
    body?.error?.code ?? null,
    fieldErrors,
    problems,
  );
}

/**
 * Non-throwing variant for callers that do not use TanStack Query (never throws; failures come
 * back as `{ ok: false, message }`). New server-data code should use `fetchJson` through hooks.
 */
export async function apiRequest<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  try {
    return { ok: true, status: 200, data: await fetchJson<T>(url, options) };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        status: error.status,
        message: error.message,
        fieldErrors: error.fieldErrors,
      };
    }
    return { ok: false, status: 0, message: GENERIC_MESSAGE, fieldErrors: {} };
  }
}
