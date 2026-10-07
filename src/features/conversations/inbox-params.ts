import { z } from "zod";
import { listConversationsQuerySchema, type ListConversationsQuery } from "./schemas";

export const INBOX_VIEWS = [
  { id: "open", label: "Open", params: { status: "OPEN" } },
  { id: "pending", label: "Pending", params: { status: "PENDING" } },
  { id: "resolved", label: "Resolved", params: { status: "RESOLVED" } },
  { id: "all", label: "All conversations", params: {} },
  { id: "mine", label: "Assigned to me", params: { assignee: "me", status: "OPEN,PENDING" } },
  {
    id: "unassigned",
    label: "Unassigned",
    params: { assignee: "unassigned", status: "OPEN,PENDING" },
  },
  {
    id: "high",
    label: "High priority",
    params: { priority: "HIGH,URGENT", status: "OPEN,PENDING" },
  },
  { id: "urgent", label: "Urgent", params: { priority: "URGENT", status: "OPEN,PENDING" } },
] as const;

export type InboxViewId = (typeof INBOX_VIEWS)[number]["id"];

export const DEFAULT_VIEW: InboxViewId = "open";

const viewIds = INBOX_VIEWS.map((view) => view.id) as [InboxViewId, ...InboxViewId[]];

export type InboxParams = {
  view: InboxViewId;
  q: string;
  page: number;
  /** Selected conversation id (shown in the detail pane). */
  selectedId: string | null;
  /** Optional customer filter (from Customer 360). */
  customerId: string | null;
  query: ListConversationsQuery;
};

/** Turns raw URL params into a validated list query. Invalid input falls back to defaults. */
export function parseInboxParams(raw: Record<string, string>): InboxParams {
  const view = z.enum(viewIds).catch(DEFAULT_VIEW).parse(raw.view);
  const base = INBOX_VIEWS.find((candidate) => candidate.id === view)!.params;
  const parsed = listConversationsQuerySchema.safeParse({
    ...base,
    ...(raw.q ? { q: raw.q } : {}),
    ...(raw.page ? { page: raw.page } : {}),
    ...(raw.customer ? { customerId: raw.customer } : {}),
  });
  const query = parsed.success ? parsed.data : listConversationsQuerySchema.parse({ ...base });
  const selected = z.uuid().safeParse(raw.c);

  return {
    view,
    q: query.q ?? "",
    page: query.page,
    selectedId: selected.success ? selected.data : null,
    customerId: query.customerId ?? null,
    query,
  };
}

/** Builds an /dashboard/inbox URL from current params plus overrides (undefined removes a key). */
export function inboxHref(
  current: {
    view?: string;
    q?: string;
    page?: number | string;
    c?: string | null;
    customer?: string | null;
  },
  patch: Partial<{
    view: string;
    q: string;
    page: number | string;
    c: string | null;
    customer: string | null;
  }> = {},
): string {
  const merged = { ...current, ...patch };
  const search = new URLSearchParams();
  if (merged.view && merged.view !== DEFAULT_VIEW) search.set("view", merged.view);
  if (merged.q) search.set("q", merged.q);
  if (merged.page && String(merged.page) !== "1") search.set("page", String(merged.page));
  if (merged.customer) search.set("customer", merged.customer);
  if (merged.c) search.set("c", merged.c);
  const qs = search.toString();
  return qs ? `/dashboard/inbox?${qs}` : "/dashboard/inbox";
}
