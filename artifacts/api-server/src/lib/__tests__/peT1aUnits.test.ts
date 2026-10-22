/**
 * T1-A falsifiers that need no database:
 *  - returnTo validation (same-site relative paths only);
 *  - the auth_error redirect shape;
 *  - Microsoft is no longer advertised as an app sign-in option (ruling 2);
 *  - Microsoft emails are never trusted for linking; Google only with the
 *    IdP's verified claim; email always.
 */

import { describe, it, expect } from "vitest";
import { authErrorRedirectPath, sanitizeReturnTo } from "../peReturnTo";
import { PE_HELP_WIDGET_SYSTEM_PROMPT } from "../peHelpWidgetPrompt";
import { peIdentityEmailVerified } from "../peIdentity";

describe("sanitizeReturnTo", () => {
  it.each([
    ["/p/48021:25420?tool=flood#x", "/p/48021:25420?tool=flood#x"],
    ["/", "/"],
    ["https://evil.example/", "/"],
    ["//evil.example/x", "/"],
    ["/\\evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["p/relative", "/"],
    ["/api/auth/logout", "/"],
    ["/ok\nSet-Cookie: x", "/"],
    ["/" + "a".repeat(2000), "/"],
    [undefined, "/"],
    [42, "/"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeReturnTo(input)).toBe(expected);
  });
});

describe("authErrorRedirectPath", () => {
  it("carries a sanitized returnTo and drops an unsafe one", () => {
    expect(authErrorRedirectPath("link_used", "/p/1")).toBe("/?auth_error=link_used&returnTo=%2Fp%2F1");
    expect(authErrorRedirectPath("link_expired", "https://evil.example")).toBe("/?auth_error=link_expired");
  });
});

describe("Microsoft removed from app sign-in (ruling 2)", () => {
  it("the help assistant no longer offers Microsoft sign-in", () => {
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).not.toMatch(/Microsoft/);
    expect(PE_HELP_WIDGET_SYSTEM_PROMPT).toMatch(/email with a 6-digit code/);
  });
});

describe("peIdentityEmailVerified", () => {
  it("decides by provider, not by the caller's claim", () => {
    expect(peIdentityEmailVerified({ provider: "email", subject: "a@b.co", email: "a@b.co" })).toBe(true);
    expect(peIdentityEmailVerified({ provider: "google", subject: "s", email: "a@b.co", emailVerified: true })).toBe(true);
    expect(peIdentityEmailVerified({ provider: "google", subject: "s", email: "a@b.co" })).toBe(false);
    expect(peIdentityEmailVerified({ provider: "microsoft", subject: "s", email: "a@b.co", emailVerified: true })).toBe(false);
    expect(peIdentityEmailVerified({ provider: "google", subject: "s", emailVerified: true })).toBe(false);
  });
});
