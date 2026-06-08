import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateOutboundGate,
  isEoBound,
  isOutboundEnabled,
} from "../gtmPolicy";
import { attemptOutboundSend } from "../gtmOutbound";

describe("gtmPolicy outbound gate", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.OUTBOUND_ENABLED;
    delete process.env.GTM_EO_BOUND;
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("defaults OUTBOUND_ENABLED to false", () => {
    expect(isOutboundEnabled()).toBe(false);
  });

  it("blocks Tier 1 outbound when flag is off", () => {
    const gate = evaluateOutboundGate({
      action: "email_send",
      hasConsent: true,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("OUTBOUND_ENABLED=false");
    }
  });

  it("attemptOutboundSend never sends with OUTBOUND_ENABLED=false", async () => {
    const result = await attemptOutboundSend({
      action: "email_send",
      installId: "test-install-outbound",
      hasConsent: true,
    });
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.blocked).toBe(true);
      expect(result.tier).toBe(1);
    }
  });

  it("blocks when E&O not bound even if OUTBOUND_ENABLED=true", () => {
    process.env.OUTBOUND_ENABLED = "true";
    expect(isEoBound()).toBe(false);
    const gate = evaluateOutboundGate({
      action: "content_publish",
      hasConsent: true,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("GTM_EO_BOUND");
    }
  });

  it("blocks when consent missing even with flag and E&O", () => {
    process.env.OUTBOUND_ENABLED = "true";
    process.env.GTM_EO_BOUND = "true";
    const gate = evaluateOutboundGate({
      action: "email_send",
      hasConsent: false,
    });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.reason).toContain("consent_required");
    }
  });
});
