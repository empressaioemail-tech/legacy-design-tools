/**
 * Arrow-two Phase 3 — calibration overlay integration tests (migration 0037 fixture).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const mocks = vi.hoisted(() => ({
  db: null as unknown,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!mocks.db) throw new Error("engine-core.test: mocks.db not set");
      return mocks.db;
    },
  };
});

import { withTestSchema, type TestDb } from "@workspace/db/testing";
import {
  atomCalibrationOverlay,
  atomEvents,
  codeAtomSources,
  codeAtoms,
  engagements,
  findings,
  reasoningAtoms,
  submissions,
  PUBLIC_CALIBRATION_TENANT,
} from "@workspace/db";
import { canonicalOverlayKeyFromCodeToken } from "@workspace/codes";
import {
  ensureCorpusOverlayRow,
  recomputeCalibrationOverlay,
  resolveOverlayCalibration,
  resolveOverlayKeyFromStructuredRef,
  seedReasoningOverlayFromAtom,
  effectiveConfidence,
  invalidateStaleCalibrationForAtom,
} from "../overlay";
import { computeAttributionCoverage } from "../attribution";
import { stampsMatch, stampFromFields } from "../stamp";

const REASONING_REF = "[[CODE:reasoning:fbc-2023:fbc-m601-6]]";
const REASONING_ID = "reasoning:fbc-2023:fbc-m601-6";

beforeEach(() => {
  mocks.db = null;
});

let eventSeq = 0;

async function seedEngagementFinding(
  db: TestDb,
  args: {
    tenant: string;
    findingAtomId: string;
    citedAtomId: string;
    confidence?: string;
  },
) {
  const [eng] = await db
    .insert(engagements)
    .values({
      name: `Cal ${args.tenant}`,
      nameLower: `cal ${args.tenant}`,
      jurisdiction: "Test",
      cortexJurisdictionKey: args.tenant,
      status: "active",
    })
    .returning();
  const [sub] = await db
    .insert(submissions)
    .values({ engagementId: eng!.id, jurisdiction: "Test" })
    .returning();
  await db.insert(findings).values({
    atomId: args.findingAtomId,
    submissionId: sub!.id,
    severity: "concern",
    category: "setback",
    status: "accepted",
    text: "Calibration test finding",
    citations: [{ kind: "code-section", atomId: args.citedAtomId }],
    confidence: args.confidence ?? "0.85",
    aiGeneratedAt: new Date("2026-06-01T00:00:00Z"),
  });
  return { engagement: eng!, submission: sub! };
}

describe("structured-ref overlay resolution", () => {
  it("resolves [[CODE:reasoning:...]] to canonical overlay key", async () => {
    expect(resolveOverlayKeyFromStructuredRef(REASONING_REF)).toBe(REASONING_ID);
    expect(canonicalOverlayKeyFromCodeToken(REASONING_REF)).toBe(REASONING_ID);
  });
});

describe("overlay covers reasoning + corpus atoms", () => {
  it("resolves calibration for both atom kinds without corpus mutation", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;

      await db.insert(reasoningAtoms).values({
        id: REASONING_ID,
        jurisdictionKey: "miami_beach_fl",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        sources: [],
        assertedConfidence: "0.8",
        verificationState: "verified",
        displayMode: "deeplink",
        accessPolicy: "platform-internal",
      });
      await seedReasoningOverlayFromAtom({ reasoningAtomId: REASONING_ID });

      const [src] = await db
        .insert(codeAtomSources)
        .values({
          sourceName: "test_pdf_source",
          label: "Test PDF",
          sourceType: "pdf",
          licenseType: "public_record",
        })
        .returning();
      const [corpus] = await db
        .insert(codeAtoms)
        .values({
          sourceId: src!.id,
          jurisdictionKey: "bastrop_tx",
          codeBook: "IRC",
          edition: "2021",
          sectionNumber: "R301.2",
          body: "Design criteria body",
          contentHash: `hash-cal-${Date.now()}`,
          sourceUrl: "https://example.com/r301",
        })
        .returning();
      const corpusId = corpus!.id.toLowerCase();
      await ensureCorpusOverlayRow({
        atomId: corpusId,
        sourceType: "pdf",
        codeRef: "R301.2",
        edition: "2021",
      });

      const reasoningRow = await resolveOverlayCalibration({
        atomId: REASONING_ID,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      });
      const corpusRow = await resolveOverlayCalibration({
        atomId: corpusId,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      });

      expect(reasoningRow?.atomId).toBe(REASONING_ID);
      expect(corpusRow?.atomId).toBe(corpusId);
      expect(Number(corpusRow?.assertedConfidence)).toBeGreaterThan(0.7);

      const corpusAfter = await db
        .select({ body: codeAtoms.body })
        .from(codeAtoms)
        .where(eq(codeAtoms.id, corpus!.id));
      expect(corpusAfter[0]!.body).toBe("Design criteria body");
    });
  });
});

describe("cold-start fallback", () => {
  it("reads assertedConfidence when no calibration signal — never zero", async () => {
    const eff = effectiveConfidence({
      assertedConfidence: 0.72,
      calibratedConfidence: null,
      calibrationStale: false,
    });
    expect(eff.value).toBeCloseTo(0.72, 3);
    expect(eff.grade).toBe("asserted");
    expect(eff.value).toBeGreaterThan(0);
  });
});

describe("tenant sovereignty — two-tenant no leakage", () => {
  it("public grade pools anonymous only; tenant overlays stay isolated", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const sharedAtom = REASONING_ID;

      await db.insert(reasoningAtoms).values({
        id: sharedAtom,
        jurisdictionKey: "miami_beach_fl",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        sources: [],
        assertedConfidence: "0.75",
        verificationState: "verified",
        displayMode: "deeplink",
        accessPolicy: "platform-internal",
      });

      await db.insert(atomCalibrationOverlay).values({
        atomId: sharedAtom,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
        partitionKind: "public",
        accessPolicy: "public-free",
        assertedConfidence: "0.75",
        calibratedConfidence: "0.91",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 1,
        signalCount: 5,
        calibrationGrain: "atom",
      });
      await db.insert(atomCalibrationOverlay).values({
        atomId: sharedAtom,
        jurisdictionTenant: "bastrop_tx",
        partitionKind: "tenant-private",
        accessPolicy: "tenant-private",
        assertedConfidence: "0.75",
        calibratedConfidence: "0.55",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 1,
        signalCount: 4,
        calibrationGrain: "atom",
      });
      await db.insert(atomCalibrationOverlay).values({
        atomId: sharedAtom,
        jurisdictionTenant: "elgin_tx",
        partitionKind: "tenant-private",
        accessPolicy: "tenant-private",
        assertedConfidence: "0.75",
        calibratedConfidence: "0.62",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 1,
        signalCount: 4,
        calibrationGrain: "atom",
      });

      const publicRow = await resolveOverlayCalibration({
        atomId: sharedAtom,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      });
      const bastropRow = await resolveOverlayCalibration({
        atomId: sharedAtom,
        jurisdictionTenant: "bastrop_tx",
      });
      const elginRow = await resolveOverlayCalibration({
        atomId: sharedAtom,
        jurisdictionTenant: "elgin_tx",
      });

      expect(publicRow?.calibratedConfidence).toBeCloseTo(0.91, 2);
      expect(bastropRow?.calibratedConfidence).toBeCloseTo(0.55, 2);
      expect(elginRow?.calibratedConfidence).toBeCloseTo(0.62, 2);
      expect(bastropRow?.calibratedConfidence).not.toBe(publicRow?.calibratedConfidence);
      expect(elginRow?.calibratedConfidence).not.toBe(bastropRow?.calibratedConfidence);
    });
  });
});

describe("tenant-shared no-pool into public", () => {
  it("tenant-shared partition never writes to __public__", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const atomId = "reasoning:fbc-2023:shared-sec";
      const sharedWith = ["mox_living", "partner_a"];

      await db.insert(atomCalibrationOverlay).values({
        atomId,
        jurisdictionTenant: `__shared__:${sharedWith.slice().sort().join(",")}`,
        partitionKind: "tenant-shared",
        accessPolicy: "tenant-shared",
        sharedWithTenants: sharedWith,
        assertedConfidence: "0.7",
        calibratedConfidence: "0.88",
        signalCount: 6,
        calibrationGrain: "atom",
      });

      const publicRows = await db
        .select()
        .from(atomCalibrationOverlay)
        .where(eq(atomCalibrationOverlay.jurisdictionTenant, PUBLIC_CALIBRATION_TENANT));
      expect(publicRows).toHaveLength(0);

      const sharedRow = await resolveOverlayCalibration({
        atomId,
        jurisdictionTenant: "mox_living",
      });
      expect(sharedRow).toBeNull();

      const direct = await db
        .select()
        .from(atomCalibrationOverlay)
        .where(
          eq(
            atomCalibrationOverlay.jurisdictionTenant,
            `__shared__:${sharedWith.slice().sort().join(",")}`,
          ),
        );
      expect(direct[0]?.calibratedConfidence).toBe("0.88");
      expect(direct[0]?.partitionKind).toBe("tenant-shared");
    });
  });
});

describe("source-set drift invalidation", () => {
  it("bumps sourceSetVersion invalidates stale calibration (all three stamp fields)", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      const atomId = REASONING_ID;
      await db.insert(atomCalibrationOverlay).values({
        atomId,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
        partitionKind: "public",
        accessPolicy: "public-free",
        assertedConfidence: "0.8",
        calibratedConfidence: "0.95",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 1,
        signalCount: 5,
        calibrationGrain: "atom",
      });

      const oldStamp = stampFromFields({
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 1,
      });
      const newStamp = stampFromFields({
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 2,
      });
      expect(stampsMatch(oldStamp, newStamp)).toBe(false);

      await invalidateStaleCalibrationForAtom({
        atomId,
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        sourceSetVersion: 2,
      });

      const [row] = await db
        .select()
        .from(atomCalibrationOverlay)
        .where(eq(atomCalibrationOverlay.atomId, atomId));
      expect(row?.calibrationStale).toBe(true);
      expect(row?.calibratedConfidence).toBeNull();
      expect(row?.sourceSetVersion).toBe(2);

      const resolved = await resolveOverlayCalibration({
        atomId,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
      });
      expect(resolved?.calibrationGrade).toBe("stale");
      expect(resolved?.effectiveConfidence).toBeCloseTo(0.8, 2);
    });
  });
});

describe("recompute from adjudication lineage", () => {
  it("writes overlay rows from finding citations + accept events", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      await db.insert(reasoningAtoms).values({
        id: REASONING_ID,
        jurisdictionKey: "bastrop_tx",
        codeRef: "FBC-M601.6",
        edition: "FBC 2023",
        editionSlug: "fbc-2023",
        sources: [],
        assertedConfidence: "0.8",
        verificationState: "verified",
        displayMode: "deeplink",
        accessPolicy: "platform-internal",
      });

      const { engagement } = await seedEngagementFinding(db, {
        tenant: "bastrop_tx",
        findingAtomId: "finding:cal:001",
        citedAtomId: REASONING_ID,
      });

      for (let i = 0; i < 3; i++) {
        eventSeq += 1;
        await db.insert(atomEvents).values({
          id: `ev-cal-${eventSeq}`,
          entityType: "finding",
          entityId: "finding:cal:001",
          eventType: "finding.accepted",
          actor: { kind: "user", id: "reviewer" },
          payload: {},
          prevHash: null,
          chainHash: `hash-cal-${eventSeq}`,
        });
      }

      const { rowsWritten } = await recomputeCalibrationOverlay();
      expect(rowsWritten).toBeGreaterThan(0);

      const tenantRow = await resolveOverlayCalibration({
        atomId: REASONING_ID,
        jurisdictionTenant: "bastrop_tx",
      });
      expect(tenantRow?.signalCount).toBeGreaterThanOrEqual(3);
      expect(tenantRow?.partitionKind).toBe("tenant-private");
      expect(engagement.cortexJurisdictionKey).toBe("bastrop_tx");
    });
  });
});

describe("attribution coverage", () => {
  it("measures write-time overlay hit rate for cited atoms", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      await seedEngagementFinding(db, {
        tenant: "bastrop_tx",
        findingAtomId: "finding:attr:001",
        citedAtomId: REASONING_ID,
      });
      await db.insert(atomCalibrationOverlay).values({
        atomId: REASONING_ID,
        jurisdictionTenant: PUBLIC_CALIBRATION_TENANT,
        partitionKind: "public",
        accessPolicy: "public-free",
        assertedConfidence: "0.7",
      });

      const health = await computeAttributionCoverage({
        jurisdictionTenant: "bastrop_tx",
      });
      expect(health.citationsResolved).toBe(1);
      expect(health.overlayHits).toBe(1);
      expect(health.attributionCoverageRate).toBe(1);
    });
  });
});
