import { describe, expect, it } from "vitest";
import {
  RESEARCH_CHAT_CUSTOMER_DISCLAIMER,
  sanitizeResearchChatCustomerText,
} from "../brokerageResearchChatSanitize";

describe("sanitizeResearchChatCustomerText", () => {
  it("removes Hauska from a fixture answer", () => {
    const raw =
      "Hauska shows SF-1 setbacks here. This is not a Hauska atom — verify with the city.";
    const out = sanitizeResearchChatCustomerText(raw);
    expect(out).not.toMatch(/Hauska/i);
    expect(out).toContain("Smart Site");
  });

  it("uses the Smart Site disclaimer copy", () => {
    expect(RESEARCH_CHAT_CUSTOMER_DISCLAIMER).not.toMatch(/Hauska/i);
    expect(RESEARCH_CHAT_CUSTOMER_DISCLAIMER).toContain("public records");
  });
});
