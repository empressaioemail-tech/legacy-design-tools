/**
 * Trusted service impersonation via X-PE-User-Id + SERVICE_API_KEY.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Request } from "express";
import {
  PE_SERVICE_USER_ID_HEADER,
  resolvePeUserIdFromTrustedServiceCall,
} from "../lib/peServiceUserId";
import { __resetServiceApiKeyCacheForTests } from "../lib/serviceToken";

const TOKEN = "test-service-token-abc123";

function mockReq(headers: Record<string, string> = {}): Request {
  const lower = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    header: (name: string) => lower.get(name.toLowerCase()),
  } as unknown as Request;
}

beforeEach(() => {
  process.env.SERVICE_API_KEY = TOKEN;
  __resetServiceApiKeyCacheForTests();
});

describe("resolvePeUserIdFromTrustedServiceCall", () => {
  it("returns user id when bearer matches SERVICE_API_KEY", () => {
    const req = mockReq({
      Authorization: `Bearer ${TOKEN}`,
      [PE_SERVICE_USER_ID_HEADER]: "user-a",
    });
    expect(resolvePeUserIdFromTrustedServiceCall(req)).toBe("user-a");
  });

  it("returns null when bearer is wrong", () => {
    const req = mockReq({
      Authorization: "Bearer wrong-token",
      [PE_SERVICE_USER_ID_HEADER]: "user-a",
    });
    expect(resolvePeUserIdFromTrustedServiceCall(req)).toBeNull();
  });

  it("returns null when header is missing", () => {
    const req = mockReq({ Authorization: `Bearer ${TOKEN}` });
    expect(resolvePeUserIdFromTrustedServiceCall(req)).toBeNull();
  });

  it("returns null for anonymous owner ids", () => {
    const req = mockReq({
      Authorization: `Bearer ${TOKEN}`,
      [PE_SERVICE_USER_ID_HEADER]: "anon_deadbeef1234",
    });
    expect(resolvePeUserIdFromTrustedServiceCall(req)).toBeNull();
  });
});
