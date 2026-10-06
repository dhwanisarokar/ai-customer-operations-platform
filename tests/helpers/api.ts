type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

/** Invokes a route handler directly, the same way Next.js would, and returns status + JSON. */
export async function call(
  handler: unknown,
  options: {
    method?: string;
    body?: unknown;
    rawBody?: string;
    params?: Record<string, string>;
  } = {},
) {
  const { method = "GET", body, rawBody, params = {} } = options;
  const request = new Request("http://localhost/api/test", {
    method,
    headers: { "content-type": "application/json" },
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const response = await (handler as Handler)(request, {
    params: Promise.resolve(params) as Promise<never>,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
