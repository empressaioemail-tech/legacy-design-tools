/**
 * Unit tests for Phase 1 anonymous demo owner scoping (production-safe).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  anonymousOwnerUserId,
  effectiveOwnerUserId,
  engagementOwnerWhere,
  sessionOwnerUserId,
} from "../engagementOwnership";
import { MIGRATION_OWNER_USER_ID } from "../sessionToken";
import type { SessionUser } from "../../middlewares/session";

const anonymous: SessionUser = {
  audience: "user",
  tenantId: "default",
};

const userA: SessionUser = {
  audience: "user",
  tenantId: "default",
  requestor: { kind: "user", id: "user-a" },
};

describe("engagementOwnership — anonymous demo path", () => {
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it("anonymousOwnerUserId matches migration backfill owner", () => {
    expect(anonymousOwnerUserId()).toBe(MIGRATION_OWNER_USER_ID);
  });

  it("anonymous production session resolves to migration-owner", () => {
    expect(sessionOwnerUserId(anonymous)).toBeNull();
    expect(effectiveOwnerUserId(anonymous)).toBe(MIGRATION_OWNER_USER_ID);
    expect(engagementOwnerWhere(anonymous)).toBeDefined();
  });

  it("signed-in user scopes to their own owner id", () => {
    expect(effectiveOwnerUserId(userA)).toBe("user-a");
  });
});
