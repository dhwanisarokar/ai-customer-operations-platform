import { addTestMember, createTestOrganization, createTestUser } from "./db";
import { resetSession } from "./mocks";
import { seedCustomer } from "./tenants";

/**
 * Two tenants for knowledge / AI tests:
 *   Org A: ownerA (OWNER), adminA (ADMIN), memberA (MEMBER) + customerA
 *   Org B: ownerB (OWNER) + customerB
 */
export async function setupAiTenants() {
  resetSession();
  const ownerA = await createTestUser("ownera");
  const adminA = await createTestUser("admina");
  const memberA = await createTestUser("membera");
  const ownerB = await createTestUser("ownerb");
  const orgA = await createTestOrganization(ownerA, "Org A");
  const orgB = await createTestOrganization(ownerB, "Org B");
  await addTestMember(orgA.id, adminA.id, "ADMIN");
  await addTestMember(orgA.id, memberA.id, "MEMBER");
  const customerA = await seedCustomer(orgA.id, {
    firstName: "Alice",
    lastName: "Anders",
    email: "alice.private@a.test",
    phone: "+15550100",
    company: "Acme",
  });
  const customerB = await seedCustomer(orgB.id, {
    firstName: "Bob",
    lastName: "Baker",
    email: "bob.secret@b.test",
    company: "Bakery",
  });
  return { ownerA, adminA, memberA, ownerB, orgA, orgB, customerA, customerB };
}

export const REFUND_DOC = {
  title: "Refund policy",
  content:
    "Refunds are available within 30 days of purchase.\n\nTo request a refund, contact support with your order number.",
};

export const SHIPPING_DOC = {
  title: "Shipping times",
  content: "Standard shipping takes 5 business days. Express shipping takes 2 business days.",
};

/** Creates a published document through the real service layer (indexes with the installed AI provider). */
export async function createPublishedDocument(
  ctx: import("@/server/auth/context").OrganizationContext,
  doc: { title: string; content: string; description?: string | null },
) {
  const { createDocument, publishDocument } = await import("@/server/services/knowledge");
  const created = await createDocument(ctx, {
    title: doc.title,
    description: doc.description ?? null,
    content: doc.content,
  });
  return publishDocument(ctx, created.id);
}

export async function chunksOf(documentId: string) {
  const { getDb } = await import("@/db/client");
  return getDb().$queryRaw<
    { id: string; chunkIndex: number; content: string; contentVersion: number; dims: number }[]
  >`SELECT id, "chunkIndex", content, "contentVersion", vector_dims(embedding) AS dims
    FROM knowledge_document_chunks WHERE "documentId" = ${documentId}::uuid ORDER BY "chunkIndex"`;
}

export async function documentRow(id: string) {
  const { getDb } = await import("@/db/client");
  return getDb().knowledgeDocument.findUniqueOrThrow({ where: { id } });
}
