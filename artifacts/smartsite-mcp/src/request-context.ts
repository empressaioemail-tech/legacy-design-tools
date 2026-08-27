import { AsyncLocalStorage } from "node:async_hooks";

import type { PeSubscriptionTier } from "@workspace/db/schema";

export type SmartsiteAuthContext = {
  userId: string;
  email: string | null;
  accessTier: "free" | "paid";
  subscriptionTier: PeSubscriptionTier | null;
  devRole: boolean;
};

const storage = new AsyncLocalStorage<SmartsiteAuthContext>();

export function runWithAuth<T>(
  ctx: SmartsiteAuthContext,
  fn: () => T,
): T {
  return storage.run(ctx, fn);
}

export function getAuthContext(): SmartsiteAuthContext | undefined {
  return storage.getStore();
}

export function requireAuthContext(): SmartsiteAuthContext {
  const ctx = getAuthContext();
  if (!ctx) {
    throw new Error("smartsite_mcp_auth_required");
  }
  return ctx;
}
