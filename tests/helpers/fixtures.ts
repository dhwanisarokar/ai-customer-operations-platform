import type {
  ConversationJson,
  ConversationListResponse,
  MessageJson,
} from "@/features/conversations/api/types";
import type {
  CustomerListResponse,
  CustomerRow,
  Customer360Response,
} from "@/features/customers/api/types";

/** Minimal, typed JSON fixtures shared by the data-layer tests. */

export const conversation = (overrides: Partial<ConversationJson> = {}): ConversationJson => ({
  id: "c1",
  subject: "Billing question",
  status: "OPEN",
  priority: "NORMAL",
  channel: "IN_APP",
  customer: { id: "cust1", name: "Alice Anders", email: null, company: "Acme", status: "ACTIVE" },
  assignee: null,
  lastMessageAt: "2026-01-01T10:00:00.000Z",
  lastMessagePreview: "Hello",
  lastMessageSenderType: "CUSTOMER",
  unread: true,
  createdAt: "2026-01-01T09:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
  closedAt: null,
  ...overrides,
});

export const conversationList = (items: ConversationJson[]): ConversationListResponse => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  totalPages: 1,
});

export const message = (overrides: Partial<MessageJson> = {}): MessageJson => ({
  id: "m1",
  senderType: "USER",
  senderUserId: "u1",
  messageType: "MESSAGE",
  body: "Hi",
  createdAt: "2026-01-01T10:05:00.000Z",
  sender: { id: "u1", name: "Dana", email: "dana@example.com" },
  ai: null,
  ...overrides,
});

export const customerRow = (overrides: Partial<CustomerRow> = {}): CustomerRow => ({
  id: "cust1",
  firstName: "Alice",
  lastName: "Anders",
  email: "alice@example.com",
  phone: null,
  company: "Acme",
  jobTitle: null,
  status: "ACTIVE",
  source: null,
  lastActivityAt: "2026-01-01T10:00:00.000Z",
  createdAt: "2026-01-01T09:00:00.000Z",
  updatedAt: "2026-01-01T09:00:00.000Z",
  tags: [],
  ...overrides,
});

export const customerList = (items: CustomerRow[]): CustomerListResponse => ({
  items,
  page: 1,
  pageSize: 25,
  total: items.length,
  totalPages: 1,
});

export const customer360 = (
  customer: Partial<Customer360Response["customer"]> = {},
): Customer360Response => ({
  customer: {
    id: "cust1",
    externalId: null,
    firstName: "Alice",
    lastName: "Anders",
    email: "alice@example.com",
    phone: null,
    company: "Acme",
    jobTitle: null,
    status: "ACTIVE",
    source: null,
    metadata: null,
    lastActivityAt: "2026-01-01T10:00:00.000Z",
    createdAt: "2026-01-01T09:00:00.000Z",
    updatedAt: "2026-01-01T09:00:00.000Z",
    archivedAt: null,
    ...customer,
  },
  tags: [],
  recentActivities: [],
  notes: [],
  conversations: [],
  counts: { activities: 0, notes: 0, conversations: 0 },
});
