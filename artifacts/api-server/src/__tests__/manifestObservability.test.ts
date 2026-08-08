/**
 * manifestObservability writer integration tests.
 *
 * Uses the real-PG route harness (setup.ts). Requires TEST_DATABASE_URL /
 * DATABASE_URL — CI-authoritative when unset.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  railStateHistory,
  manifestRun,
  manifestSlotReservation,
} from "@workspace/db";
import { truncateAll } from "@workspace/db/testing";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("manifestObservability.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { db } = await import("@workspace/db");
const { setupRouteTests } = await import("./setup");
setupRouteTests();

import {
  appendRailStateSnapshotIfChanged,
  recordRailVerification,
  getLatestRailVerification,
  startManifestRun,
  updateManifestRunProgress,
  completeManifestRun,
  acquireManifestSlot,
  releaseManifestSlot,
  enqueueManifestSlot,
  listManifestSlotQueue,
  applyManifestRunCostToJurisdiction,
  getManifestJurisdictionCost,
  DEFAULT_HEAVY_SCAN_RESOURCE,
} from "../lib/manifestObservability";

const OBSERVABILITY_TABLES = [
  "rail_verification",
  "rail_state_history",
  "manifest_slot_queue",
  "manifest_slot_reservation",
  "manifest_jurisdiction_cost",
  "manifest_run",
] as const;

function writerDb() {
  if (!ctx.schema) throw new Error("manifestObservability.test: ctx.schema not set");
  return ctx.schema.db;
}

describe("manifestObservability writers", () => {
  afterEach(async () => {
    if (!ctx.schema) return;
    await truncateAll(ctx.schema.pool, OBSERVABILITY_TABLES);
  });

  it("appendRailStateSnapshotIfChanged detects regressions", async () => {
    const wdb = writerDb();
    const first = await appendRailStateSnapshotIfChanged(
      {
        countyFips: "48021",
        railKey: "zoning",
        railState: "satisfied-present",
        honestCoveragePct: "95.00",
        thresholdPct: "95.00",
        verifiedAt: null,
        snapshotReason: "cell-change",
      },
      wdb,
    );
    expect(first).toBeTruthy();

    const duplicate = await appendRailStateSnapshotIfChanged(
      {
        countyFips: "48021",
        railKey: "zoning",
        railState: "satisfied-present",
        honestCoveragePct: "95.00",
        thresholdPct: "95.00",
        verifiedAt: null,
        snapshotReason: "cell-change",
      },
      wdb,
    );
    expect(duplicate).toBeNull();

    const regression = await appendRailStateSnapshotIfChanged(
      {
        countyFips: "48021",
        railKey: "zoning",
        railState: "not-yet",
        honestCoveragePct: "40.00",
        thresholdPct: "95.00",
        verifiedAt: null,
        snapshotReason: "cell-change",
      },
      wdb,
    );
    expect(regression).toBeTruthy();

    const rows = await db
      .select()
      .from(railStateHistory)
      .where(
        and(
          eq(railStateHistory.countyFips, "48021"),
          eq(railStateHistory.railKey, "zoning"),
        ),
      );
    expect(rows).toHaveLength(2);
  });

  it("rail_verification: no row vs confirmed-absent", async () => {
    const wdb = writerDb();
    expect(await getLatestRailVerification("48021", "envelope", wdb)).toBeNull();

    await recordRailVerification(
      {
        countyFips: "48021",
        railKey: "envelope",
        verifiedAt: new Date("2026-08-08T12:00:00Z"),
        verifiedByInstrument: "area-sweep-48021",
        verificationMethod: "sweep",
        verificationOutcome: "confirmed-absent",
        artifactPath: "gs://artifacts/sweep-48021.json",
      },
      wdb,
    );

    const latest = await getLatestRailVerification("48021", "envelope", wdb);
    expect(latest?.verificationMethod).toBe("sweep");
    expect(latest?.verificationOutcome).toBe("confirmed-absent");
  });

  it("run lifecycle + slot hold + queue", async () => {
    const wdb = writerDb();
    const runId = await startManifestRun(
      {
        lane: "T1",
        job: "bastrop-cohort-rewarm",
        stage: "promote",
        targetFips: "48021",
        cohort: "bastrop-city",
        runClass: "rewarm",
      },
      wdb,
    );

    await updateManifestRunProgress(
      { runId, stage: "verify", itemsDone: 100, itemsTotal: 1000 },
      wdb,
    );

    await acquireManifestSlot(DEFAULT_HEAVY_SCAN_RESOURCE, runId, wdb);

    const queuedRunId = await startManifestRun(
      {
        lane: "T5",
        job: "bexar-onboard",
        stage: "queued",
        targetFips: "48029",
        runClass: "acquisition",
      },
      wdb,
    );
    const pos = await enqueueManifestSlot(
      DEFAULT_HEAVY_SCAN_RESOURCE,
      queuedRunId,
      wdb,
    );
    expect(pos).toBe(1);

    const queue = await listManifestSlotQueue(DEFAULT_HEAVY_SCAN_RESOURCE, wdb);
    expect(queue).toHaveLength(1);

    await releaseManifestSlot(DEFAULT_HEAVY_SCAN_RESOURCE, runId, wdb);

    const [reservation] = await db
      .select()
      .from(manifestSlotReservation)
      .where(eq(manifestSlotReservation.holderRunId, runId));
    expect(reservation.releasedAt).not.toBeNull();
  });

  it("dual cost counters: commitment vs lifetime", async () => {
    const wdb = writerDb();
    const acqRun = await startManifestRun(
      {
        lane: "T5",
        job: "first-acquire",
        stage: "done",
        targetFips: "48021",
        runClass: "acquisition",
      },
      wdb,
    );

    await applyManifestRunCostToJurisdiction(
      "48021",
      acqRun,
      180.5,
      { countsTowardCommitment: true, isSuccessfulAcquisition: true },
      wdb,
    );

    const rewarmRun = await startManifestRun(
      {
        lane: "T1",
        job: "rewarm",
        stage: "done",
        targetFips: "48021",
        runClass: "rewarm",
      },
      wdb,
    );

    await applyManifestRunCostToJurisdiction(
      "48021",
      rewarmRun,
      50.25,
      { countsTowardCommitment: false, isSuccessfulAcquisition: false },
      wdb,
    );

    const cost = await getManifestJurisdictionCost("48021", wdb);
    expect(Number(cost?.commitmentCostUsd)).toBe(180.5);
    expect(Number(cost?.lifetimeCostUsd)).toBeCloseTo(230.75, 2);
    expect(cost?.firstAcquisitionRunId).toBe(acqRun);
  });

  it("completeManifestRun records cost on run row", async () => {
    const wdb = writerDb();
    const runId = await startManifestRun(
      { lane: "T1", job: "score", stage: "run", runClass: "score" },
      wdb,
    );

    await completeManifestRun(
      runId,
      {
        status: "succeeded",
        outcome: "ok",
        cost: { computeSeconds: 3600, costUsd: 12.34, externalApiCalls: 42 },
      },
      wdb,
    );

    const [row] = await db
      .select()
      .from(manifestRun)
      .where(eq(manifestRun.id, runId));
    expect(row.status).toBe("succeeded");
    expect(Number(row.costUsd)).toBe(12.34);
    expect(row.externalApiCalls).toBe(42);
  });
});
