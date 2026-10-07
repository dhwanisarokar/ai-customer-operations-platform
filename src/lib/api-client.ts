export type FieldErrors = Record<string, string>;

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; message: string; fieldErrors: FieldErrors };

type ErrorBody = {
  error?: { message?: string; details?: { path: string; message: string }[] };
};

/**
 * Browser-side wrapper for our JSON API. Never throws: network and server failures come back as
 * `{ ok: false, message }` with a safe message, and validation details become field errors.
 */
export async function apiRequest<T = unknown>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (response.ok) {
      const data = response.status === 204 ? null : await response.json();
      return { ok: true, status: response.status, data: data as T };
    }

    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    const fieldErrors: FieldErrors = {};
    for (const detail of body?.error?.details ?? []) {
      if (detail.path && !fieldErrors[detail.path]) fieldErrors[detail.path] = detail.message;
    }
    return {
      ok: false,
      status: response.status,
      message: body?.error?.message ?? "Something went wrong. Please try again.",
      fieldErrors,
    };
  } catch {
    return { ok: false, status: 0, message: "Network error. Please try again.", fieldErrors: {} };
  }
}
