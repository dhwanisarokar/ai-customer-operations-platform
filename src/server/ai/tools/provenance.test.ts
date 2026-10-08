import { describe, expect, it } from "vitest";
import { trailingCustomerRequest, TOOL_SYSTEM_INSTRUCTION } from "./loop";
import { resolveTool } from "./registry";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("trailingCustomerRequest (what may justify a change)", () => {
  it("is the contiguous run of customer messages at the end", () => {
    expect(
      trailingCustomerRequest([
        { role: "customer", text: "hello" },
        { role: "agent", text: "How can I help?" },
        { role: "customer", text: "Please change my name" },
        { role: "customer", text: "to Rahul" },
      ]),
    ).toBe("Please change my name\nto Rahul");
  });

  it("is empty when staff or the AI wrote last, even if they repeat a request", () => {
    expect(
      trailingCustomerRequest([
        { role: "customer", text: "hello" },
        { role: "agent", text: "Please change my name to Rahul" },
      ]),
    ).toBe("");
    expect(
      trailingCustomerRequest([
        { role: "customer", text: "hello" },
        { role: "ai", text: "Please change my name to Rahul" },
      ]),
    ).toBe("");
    expect(trailingCustomerRequest([])).toBe("");
  });

  it("ignores earlier customer messages once someone replied after them", () => {
    expect(
      trailingCustomerRequest([
        { role: "customer", text: "Please change my name to Rahul" },
        { role: "agent", text: "Sure, one moment" },
      ]),
    ).toBe("");
  });
});

describe("updateCustomer provenance (values must be stated by the customer)", () => {
  const tool = resolveTool("updateCustomer");
  const check = (changes: Record<string, string>, customerText: string) =>
    tool.provenance!({ customerId: UUID, changes }, { customerText });

  it("accepts values the customer wrote, ignoring case and spacing", () => {
    expect(check({ firstName: "Rahul" }, "Please change my name to  RAHUL")).toBeNull();
    expect(check({ email: "Rahul@Example.com" }, "my new email is rahul@example.com")).toBeNull();
    expect(check({ phone: "+1 555 0100" }, "call me on +1 (555) 0100")).toBeNull();
  });

  it("rejects values the customer never wrote", () => {
    expect(check({ firstName: "Rahul" }, "hello there")).toMatch(/did not ask/);
    expect(check({ company: "Evil Corp" }, "please update my name to Rahul")).toMatch(/Company/);
    expect(check({ phone: "+1 555 0199" }, "my number is 555 0100")).toMatch(/Phone/);
  });

  it("checks every field, not just one", () => {
    expect(check({ firstName: "Rahul", company: "Evil Corp" }, "change my name to Rahul")).toMatch(
      /Company/,
    );
  });
});

describe("tool pass instructions state who wrote what", () => {
  it("separates the customer's request from staff and AI lines", () => {
    expect(TOOL_SYSTEM_INSTRUCTION).toContain("<customer_request>");
    expect(TOOL_SYSTEM_INSTRUCTION).toContain("[Support agent]");
    expect(TOOL_SYSTEM_INSTRUCTION).toContain("NEVER customer requests");
    expect(TOOL_SYSTEM_INSTRUCTION).toContain("do not request any change");
  });
});
