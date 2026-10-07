import { describe, expect, it } from "vitest";
import { createToolRegistry, defaultToolRegistry, resolveTool, toolDeclarations } from "./registry";
import { ToolError } from "./types";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("tool registry", () => {
  it("contains exactly the five Phase 5 tools with application-defined risk and permissions", () => {
    const summary = [...defaultToolRegistry.values()].map((tool) => [
      tool.name,
      tool.riskLevel,
      tool.requiredPermission,
    ]);
    expect(summary).toEqual([
      ["getCustomer", "LOW", "view_customers"],
      ["getConversation", "LOW", "view_conversations"],
      ["searchKnowledge", "LOW", "view_knowledge"],
      ["updateCustomer", "MEDIUM", "update_customers"],
      ["changeConversationStatus", "MEDIUM", "update_conversations"],
    ]);
  });

  it("every mutating tool can describe its change for the approver", () => {
    for (const tool of defaultToolRegistry.values()) {
      if (tool.riskLevel !== "LOW") expect(tool.preview).toBeTypeOf("function");
    }
  });

  it("resolves known tools and rejects unknown names", () => {
    expect(resolveTool("getCustomer").name).toBe("getCustomer");
    expect(() => resolveTool("dropAllTables")).toThrow(ToolError);
    expect(() => resolveTool("dropAllTables")).toThrow("does not exist");
    expect(() => resolveTool("getCustomer", createToolRegistry([]))).toThrow(ToolError);
  });

  it("declares JSON schemas without any organization, user or permission field", () => {
    const declarations = toolDeclarations();
    expect(declarations.map((d) => d.name)).toHaveLength(5);
    for (const declaration of declarations) {
      expect(declaration.description.length).toBeGreaterThan(10);
      expect(declaration.parametersJsonSchema.type).toBe("object");
      expect(declaration.parametersJsonSchema).not.toHaveProperty("$schema");
      const serialized = JSON.stringify(declaration.parametersJsonSchema);
      expect(serialized).not.toMatch(/organization|userId|permission|role|approved|allow/i);
    }
  });
});

describe("tool input validation (strict Zod schemas)", () => {
  const parse = (name: string, input: unknown) => resolveTool(name).inputSchema.safeParse(input);

  it("accepts well-formed inputs", () => {
    expect(parse("getCustomer", { customerId: UUID }).success).toBe(true);
    expect(parse("getConversation", {}).success).toBe(true);
    expect(parse("searchKnowledge", { query: "refund policy" }).success).toBe(true);
    expect(
      parse("updateCustomer", { customerId: UUID, changes: { company: "Acme Inc." } }).success,
    ).toBe(true);
    expect(parse("changeConversationStatus", { status: "RESOLVED" }).success).toBe(true);
  });

  it("rejects model-supplied tenant, user or authorization fields", () => {
    expect(parse("getCustomer", { customerId: UUID, organizationId: UUID }).success).toBe(false);
    expect(parse("getConversation", { organizationId: UUID }).success).toBe(false);
    expect(parse("searchKnowledge", { query: "x", organizationId: UUID }).success).toBe(false);
    expect(parse("changeConversationStatus", { status: "OPEN", userId: UUID }).success).toBe(false);
    expect(
      parse("updateCustomer", { customerId: UUID, changes: { company: "A" }, allow: true }).success,
    ).toBe(false);
  });

  it("rejects arbitrary fields and operators in customer changes", () => {
    for (const changes of [
      { metadata: { a: 1 } },
      { organizationId: UUID },
      { id: UUID },
      { $set: { company: "x" } },
      { status: "ARCHIVED" },
      {},
    ]) {
      expect(parse("updateCustomer", { customerId: UUID, changes }).success).toBe(false);
    }
  });

  it("rejects malformed values", () => {
    expect(parse("getCustomer", { customerId: "not-a-uuid" }).success).toBe(false);
    expect(parse("searchKnowledge", { query: "" }).success).toBe(false);
    expect(parse("searchKnowledge", { query: "x".repeat(301) }).success).toBe(false);
    expect(parse("changeConversationStatus", { status: "DELETED" }).success).toBe(false);
  });
});
