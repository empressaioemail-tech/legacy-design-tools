import { describe, it, expect } from "vitest";
import {
  canReadSmartFilePolicy,
  type SmartFileAccessSubject,
} from "../lib/smartFileAccess";

describe("smartFileAccess", () => {
  const platformOp: SmartFileAccessSubject = {
    platformInternal: true,
    jurisdictionTenant: null,
    paidTier: false,
  };
  const anon: SmartFileAccessSubject = {
    platformInternal: false,
    jurisdictionTenant: null,
    paidTier: false,
  };
  const tenantUser: SmartFileAccessSubject = {
    platformInternal: false,
    jurisdictionTenant: "bastrop-tx",
    paidTier: false,
  };

  it("allows platform-internal for operator", () => {
    expect(canReadSmartFilePolicy(platformOp, "platform-internal")).toBe(true);
  });

  it("denies tenant-private for anonymous caller", () => {
    expect(
      canReadSmartFilePolicy(anon, "tenant-private", "bastrop-tx"),
    ).toBe(false);
  });

  it("denies tenant-private for wrong tenant", () => {
    expect(
      canReadSmartFilePolicy(tenantUser, "tenant-private", "other-tx"),
    ).toBe(false);
  });

  it("allows tenant-private for matching tenant", () => {
    expect(
      canReadSmartFilePolicy(tenantUser, "tenant-private", "bastrop-tx"),
    ).toBe(true);
  });
});
