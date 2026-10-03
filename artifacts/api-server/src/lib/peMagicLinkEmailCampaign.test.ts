import { describe, expect, it } from "vitest";
import { buildMagicLinkUrl } from "./peMagicLinkEmail";

describe("the magic link carries the first-touch campaign (P-492b)", () => {
  it("VIOLATION (measured 2026-10-03): an ad arrival's UTMs reach the verify link, so email sign-ups are not filed as direct", () => {
    const url = new URL(buildMagicLinkUrl("tok", "utm_source=facebook&utm_medium=paid&utm_campaign=v2_cold&utm_content=c1_agents"));
    expect(url.pathname).toBe("/api/auth/email/verify");
    expect(url.searchParams.get("token")).toBe("tok");
    expect(url.searchParams.get("utm_medium")).toBe("paid");
    expect(url.searchParams.get("utm_content")).toBe("c1_agents");
  });
  it("only known keys with safe values are written; anything else is dropped, not escaped", () => {
    const url = new URL(buildMagicLinkUrl("tok", "utm_source=<script>&utm_medium=paid&evil=1&token=hijack"));
    expect(url.searchParams.get("utm_source")).toBeNull();
    expect(url.searchParams.get("evil")).toBeNull();
    expect(url.searchParams.getAll("token")).toEqual(["tok"]);
    expect(url.searchParams.get("utm_medium")).toBe("paid");
  });
  it("no campaign leaves the link exactly as before", () => {
    expect(buildMagicLinkUrl("tok")).toMatch(/\/api\/auth\/email\/verify\?token=tok$/);
  });
});
