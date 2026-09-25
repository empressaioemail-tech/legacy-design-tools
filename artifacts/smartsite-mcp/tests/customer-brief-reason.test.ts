import { describe, expect, it } from "vitest";
import {
  PLANTED_VINTAGE_GAP_LAND_USE,
  customerBriefReason,
  isMachineCustomerString,
} from "../src/customer-brief-reason.js";
import { reasonLineHtml } from "../src/mcp-app.js";

describe("P-458 customer brief reason", () => {
  it("humanizes the planted Travis vintage-gap string", () => {
    expect(isMachineCustomerString(PLANTED_VINTAGE_GAP_LAND_USE)).toBe(true);
    expect(customerBriefReason(PLANTED_VINTAGE_GAP_LAND_USE)).toBe(
      "Not on the 2026 roll yet (an earlier year on file)",
    );
  });

  it("reasonLineHtml never embeds the machine basis in the reason span", () => {
    const html = reasonLineHtml("reason", PLANTED_VINTAGE_GAP_LAND_USE);
    expect(html).not.toContain("48453:280238");
    expect(html).not.toContain("taxYear=");
    expect(html).toContain("Not on the 2026 roll yet");
  });
});
