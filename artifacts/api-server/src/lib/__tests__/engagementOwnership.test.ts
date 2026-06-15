/**
 * Unit tests for ephemeral anonymous owner scoping (production-safe).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  effectiveOwnerUserId,
  engagementOwnerWhere,
  isRealSignedInUser,
  sessionOwnerUserId,
} from "../engagementOwnership";
import {
  ANONYMOUS_OWNER_PREFIX,
  isAnonymousOwnerId,
} from "../anonymousOwnerCookie";
import type { SessionUser } from "../../middlewares/session";

const anonymous: SessionUser = {
  audience: "user",
  tenantId: "default",
  requestor: { kind: "user", id: `${ANONYMOUS_OWNER_PREFIX}test123` },
};

const userA: SessionUser = {
  audience: "user",
  tenantId: "default",
  requestor: { kind: "user", id: "user-a" },
};

describe("engagementOwnership — ephemeral anonymous path", () => {
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it("isAnonymousOwnerId identifies ephemeral ids", () => {
    expect(isAnonymousOwnerId(`${ANONYMOUS_OWNER_PREFIX}abc`)).toBe(true);
    expect(isAnonymousOwnerId("user-a")).toBe(false);
  });

  it("anonymous production session scopes to its ephemeral requestor id", () => {
    expect(sessionOwnerUserId(anonymous)).toBe(`${ANONYMOUS_OWNER_PREFIX}test123`);
    expect(effectiveOwnerUserId(anonymous)).toBe(`${ANONYMOUS_OWNER_PREFIX}test123`);
    expect(engagementOwnerWhere(anonymous)).toBeDefined();
  });

  it("signed-in user scopes to their own owner id", () => {
    expect(effectiveOwnerUserId(userA)).toBe("user-a");
  });

  it("ephemeral anonymous owner is not a real signed-in user", () => {
    expect(isRealSignedInUser(anonymous)).toBe(false);
    expect(isRealSignedInUser(userA)).toBe(true);
  });
});
