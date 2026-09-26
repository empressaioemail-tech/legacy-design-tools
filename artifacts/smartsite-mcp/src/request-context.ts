import { AsyncLocalStorage } from "node:async_hooks";

import type { PeSubscriptionTier } from "@workspace/db/schema";

import type { HostSessionSnapshot } from "./host-ui-capability.js";

export type SmartsiteAuthContext = {
  userId: string;
  email: string | null;
  accessTier: "free" | "paid";
  subscriptionTier: PeSubscriptionTier | null;
  devRole: boolean;
  /** P-447; absent in older test seams defaults to non-UI in tool wrappers. */
  hostSession?: HostSessionSnapshot;
};

export const DEFAULT_HOST_SESSION: HostSessionSnapshot = {
  clientName: null,
  uiCapable: false,
};

export function hostSessionFromAuth(ctx: SmartsiteAuthContext): HostSessionSnapshot {
  return ctx.hostSession ?? DEFAULT_HOST_SESSION;
}

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
