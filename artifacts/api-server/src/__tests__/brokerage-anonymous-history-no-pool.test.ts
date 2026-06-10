/**
 * ADR-005/017 — anonymous install history attaches to one user only; never pools.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  brokerageBriefRuns,
  brokerageInstallClaims,
  brokerageWorkspaces,
} from "@workspace/db";
import { claimInstallHistoryForUser } from "../lib/brokerageInstallClaim";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("brokerage-anonymous-history-no-pool: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
setupRouteTests();

const INSTALL = "install-anon-history-test-01";

describe("anonymous extension history — no pool on sign-in", () => {
  it("claims install-scoped brief runs for user-A only; user-B cannot reclaim", async () => {
    const [run] = await db
      .insert(brokerageBriefRuns)
      .values({
        listingKey: "lk-test-1",
        address: "123 Main St",
        payloadJson: { meta: { tool: "property-brief-v1" } },
        installId: INSTALL,
      })
      .returning();

    await db.insert(brokerageWorkspaces).values({
      installId: INSTALL,
      listingKey: "lk-test-1",
      address: "123 Main St",
      latestRunId: run!.id,
    });

    const claimA = await claimInstallHistoryForUser(INSTALL, "user-a");
    expect(claimA.ok).toBe(true);
    if (claimA.ok) expect(claimA.claimed).toBe(true);

    const [runAfter] = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.id, run!.id));
    expect(runAfter?.ownerUserId).toBe("user-a");
    expect(runAfter?.installId).toBe(INSTALL);

    const [wsAfter] = await db
      .select()
      .from(brokerageWorkspaces)
      .where(eq(brokerageWorkspaces.installId, INSTALL));
    expect(wsAfter?.ownerUserId).toBe("user-a");

    const claimB = await claimInstallHistoryForUser(INSTALL, "user-b");
    expect(claimB.ok).toBe(false);
    if (!claimB.ok) {
      expect(claimB.error).toBe("install_already_claimed");
      expect(claimB.claimedBy).toBe("user-a");
    }

    const allRunsForB = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.ownerUserId, "user-b"));
    expect(allRunsForB).toHaveLength(0);

    const [claimRow] = await db
      .select()
      .from(brokerageInstallClaims)
      .where(eq(brokerageInstallClaims.installId, INSTALL));
    expect(claimRow?.ownerUserId).toBe("user-a");
  });
});
