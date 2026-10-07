import { randomUUID } from "node:crypto";
import { addTestMember, createTestOrganization, createTestUser } from "./db";
import { resetSession } from "./mocks";
import { seedCustomer } from "./tenants";

/**
 * Two tenants for conversation tests:
 *   Org A: ownerA (OWNER), adminA (ADMIN), memberA (MEMBER), otherMemberA (MEMBER) + customerA
 *   Org B: ownerB (OWNER) + customerB
 */
export async function setupConversationTenants() {
  resetSession();
  const ownerA = await createTestUser("ownera");
  const adminA = await createTestUser("admina");
  const memberA = await createTestUser("membera");
  const otherMemberA = await createTestUser("othermembera");
  const ownerB = await createTestUser("ownerb");
  const orgA = await createTestOrganization(ownerA, "Org A");
  const orgB = await createTestOrganization(ownerB, "Org B");
  await addTestMember(orgA.id, adminA.id, "ADMIN");
  await addTestMember(orgA.id, memberA.id, "MEMBER");
  await addTestMember(orgA.id, otherMemberA.id, "MEMBER");
  const customerA = await seedCustomer(orgA.id, {
    firstName: "Alice",
    lastName: "Anders",
    email: "alice@a.test",
    company: "Acme",
  });
  const customerB = await seedCustomer(orgB.id, {
    firstName: "Bob",
    lastName: "Baker",
    email: "bob@b.test",
    company: "Bakery",
  });
  return { ownerA, adminA, memberA, otherMemberA, ownerB, orgA, orgB, customerA, customerB };
}

type ConversationOverrides = Partial<{
  subject: string;
  status: "OPEN" | "PENDING" | "RESOLVED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  assignedToUserId: string | null;
  lastMessageAt: Date;
  createdAt: Date;
}>;

/** Inserts a conversation straight into the database (bypassing the API) for fixtures. */
export async function seedConversation(
  organizationId: string,
  customerId: string,
  overrides: ConversationOverrides = {},
) {
  const { getDb } = await import("@/db/client");
  const now = overrides.createdAt ?? new Date();
  const status = overrides.status ?? "OPEN";
  return getDb().conversation.create({
    data: {
      organizationId,
      customerId,
      subject: overrides.subject ?? "Test conversation",
      status,
      priority: overrides.priority ?? "NORMAL",
      assignedToUserId: overrides.assignedToUserId ?? null,
      lastMessageAt: overrides.lastMessageAt ?? now,
      createdAt: now,
      closedAt: status === "RESOLVED" ? now : null,
    },
  });
}

export async function seedMessage(
  organizationId: string,
  conversationId: string,
  overrides: Partial<{
    body: string;
    senderType: "CUSTOMER" | "USER" | "SYSTEM";
    senderUserId: string | null;
    messageType: "MESSAGE" | "INTERNAL_NOTE";
    createdAt: Date;
  }> = {},
) {
  const { getDb } = await import("@/db/client");
  return getDb().message.create({
    data: {
      organizationId,
      conversationId,
      body: overrides.body ?? "hello",
      senderType: overrides.senderType ?? "CUSTOMER",
      senderUserId: overrides.senderUserId ?? null,
      messageType: overrides.messageType ?? "MESSAGE",
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

export async function eventsOf(conversationId: string) {
  const { getDb } = await import("@/db/client");
  return getDb().conversationEvent.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function conversationRow(id: string) {
  const { getDb } = await import("@/db/client");
  return getDb().conversation.findUniqueOrThrow({ where: { id } });
}

export const randomId = () => randomUUID();
