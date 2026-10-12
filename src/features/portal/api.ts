/** URL of a portal API route. The slug only selects the organization; the server verifies the rest. */
export const portalApi = (slug: string, path: string) => `/api/portal/${slug}${path}`;
