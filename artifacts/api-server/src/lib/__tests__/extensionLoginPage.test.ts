import { describe, it, expect } from "vitest";
import {
  renderExtensionLoginPage,
  resolveExtensionLoginMode,
} from "../extensionLoginPage";

describe("extension login page", () => {
  it("resolveExtensionLoginMode honors intent=signup", () => {
    expect(resolveExtensionLoginMode("signup")).toBe("signup");
    expect(resolveExtensionLoginMode("signin")).toBe("signin");
    expect(resolveExtensionLoginMode(undefined)).toBe("signin");
  });

  it("renders Hauska-branded signup with confirm password field", () => {
    const html = renderExtensionLoginPage("signup");
    expect(html).toContain('/api/auth/hauska/hauska.css');
    expect(html).toContain('/api/auth/hauska/extension-auth.css');
    expect(html).toContain('class="brand__name">Hauska</');
    expect(html).toContain('class="mark"');
    expect(html).toContain('data-initial-mode="signup"');
    expect(html).toContain('id="signup-confirm"');
    expect(html).toContain("Create account");
    expect(html).not.toContain("bare");
  });

  it("renders sign-in and reset panels", () => {
    const html = renderExtensionLoginPage("signin");
    expect(html).toContain('id="panel-signin"');
    expect(html).toContain('id="panel-reset"');
    expect(html).toContain("Forgot password?");
  });
});
