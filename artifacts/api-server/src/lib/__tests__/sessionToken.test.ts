import { describe, it, expect } from "vitest";
import { mintSessionToken, verifySessionToken } from "../sessionToken";

describe("sessionToken", () => {
  it("round-trips a signed session payload", () => {
    process.env["SESSION_SECRET"] = "unit-test-secret";
    const token = mintSessionToken({
      audience: "user",
      tenantId: "default",
      requestor: { kind: "user", id: "user-a" },
    });
    const verified = verifySessionToken(token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.session.requestor?.id).toBe("user-a");
    }
  });
});
