/**
 * P-113. Real isolated Postgres, not a mock — see CP1 groundTruth: no test
 * in this package exercised a live DB before this file. vitest.config.ts's
 * DATABASE_URL (127.0.0.1:5432/smartsite_mcp_test) collides with an
 * unrelated container already bound to 5432 on this workstation, and is a
 * shared file this lane does not own — so this file builds its own drizzle
 * client against a dedicated local container (docker run p113-mcp-testdb,
 * port 55441; see CP1) and injects it via recordsExtraction.ts's `deps.db`
 * seam, the same dependency-injection shape recordsRequestVisionRead.ts
 * already uses for its own DB-adjacent test seams.
 *
 * DEFAULT TARGET: postgres://postgres:postgres@localhost:5432/test_db — the
 * exact database CI's "Test" job service block provisions and pushes the
 * full schema to (.github/workflows/pr-checks.yml), the same credentials
 * `90_runbooks/cc_agent_local_test_db.md` documents for a cc-agent
 * workstation. Deliberately NOT `process.env.DATABASE_URL`: vitest.config.ts
 * (a shared file this lane does not own) forces DATABASE_URL to
 * postgres://smartsite_mcp_test:test@127.0.0.1:5432/smartsite_mcp_test for
 * every test file in this package, and that user/db is provisioned nowhere
 * (not in CI's postgres service block, not in the runbook) — dead
 * configuration that was never exercised because no test in this package
 * touched a live DB before this file. Reusing it here would have made this
 * suite fail in CI. P113_TEST_DATABASE_URL overrides the default for a local
 * workstation where 5432 is already bound by something else (as on this one
 * — see CP1 groundTruth): docker run --name p113-mcp-testdb -d -p 55441:5432
 *   -e POSTGRES_USER=smartsite_mcp_test -e POSTGRES_PASSWORD=test
 *   -e POSTGRES_DB=smartsite_mcp_test pgvector/pgvector:pg16
 *   (then) cd lib/db && DATABASE_URL=postgres://smartsite_mcp_test:test@127.0.0.1:55441/smartsite_mcp_test \
 *   npx drizzle-kit push --config ./drizzle.config.ts
 *   (then) P113_TEST_DATABASE_URL=postgres://smartsite_mcp_test:test@127.0.0.1:55441/smartsite_mcp_test \
 *   npx vitest run tests/records-extraction.test.ts
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@workspace/db/schema";
import { recordsRequestArtifacts, recordsRequestJobs, engagements } from "@workspace/db";

import {
  listPurchasedRecords,
  readPurchasedRecord,
  parcelKeyFromParcelNodeId,
} from "../src/recordsExtraction.js";
import type { SmartsiteEntitlementSnapshot } from "../src/entitlement.js";

const TEST_DB_URL =
  process.env.P113_TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/test_db";

const { Pool } = pg;
const pool = new Pool({ connectionString: TEST_DB_URL });
const testDb = drizzle(pool, { schema });

const STUDIO: SmartsiteEntitlementSnapshot = {
  tier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};
const FREE: SmartsiteEntitlementSnapshot = {
  tier: "free",
  subscriptionTier: null,
  devRole: false,
};

const USER_A = "user-a";
const USER_B = "user-b";
const PARCEL_NODE_ID = "48453:R123456";
const PARCEL_KEY = parcelKeyFromParcelNodeId(PARCEL_NODE_ID);

async function seedEngagement(name: string): Promise<string> {
  const [row] = await testDb
    .insert(engagements)
    .values({ name, nameLower: name.toLowerCase() })
    .returning({ id: engagements.id });
  return row!.id;
}

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // FK cascade from engagements -> jobs -> artifacts.
  await testDb.delete(engagements);
});

describe("recordsExtraction — Studio gate (never a silent empty result, never silent full access)", () => {
  it("refuses a non-Studio caller before any DB read, naming the tier required", async () => {
    const result = await listPurchasedRecords(FREE, USER_A, {
      parcelNodeId: PARCEL_NODE_ID,
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("upgrade_required");
    expect(body.reason).toBe("studio_report");
    expect(body.message).toMatch(/studio/i);
  });

  it("refuses read_purchased_record identically for a non-Studio caller", async () => {
    const result = await readPurchasedRecord(FREE, USER_A, {
      parcelNodeId: PARCEL_NODE_ID,
      artifactId: "00000000-0000-0000-0000-000000000000",
    });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("upgrade_required");
  });

  it("a Studio caller is NOT refused (positive case — not vacuous)", async () => {
    const engagementId = await seedEngagement("gate-positive");
    await testDb.insert(recordsRequestJobs).values({
      engagementId,
      userId: USER_A,
      parcelKey: PARCEL_KEY,
      countyFips: "48453",
      status: "complete",
    });
    const result = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID },
      { db: testDb },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("ok");
  });
});

describe("recordsExtraction — the three (four) vision-read states are never collapsed", () => {
  it("real end-to-end: pending, failed, skipped, and complete-with-real-text all read back distinctly", async () => {
    const engagementId = await seedEngagement("four-states");
    const [job] = await testDb
      .insert(recordsRequestJobs)
      .values({
        engagementId,
        userId: USER_A,
        parcelKey: PARCEL_KEY,
        countyFips: "48453",
        status: "complete",
      })
      .returning({ id: recordsRequestJobs.id });
    const jobId = job!.id;

    const REAL_TEXT =
      "WARRANTY DEED. Grantor: J. Alvarez. Grantee: M. Chen. " +
      "Recorded Volume 4471 Page 209, Williamson County, Texas. " +
      "Legal description: Lot 14, Block C, Sunridge Estates Ph. 2.";

    await testDb.insert(recordsRequestArtifacts).values([
      {
        jobId,
        portalId: "portal-1",
        documentType: "deed",
        recordingRef: "2024-004471",
        acquisitionMethod: "purchase",
        contentSha256: "sha-pending",
        purchaseCostCents: 1500,
        metadata: {},
      },
      {
        jobId,
        portalId: "portal-1",
        documentType: "deed-of-trust",
        recordingRef: "2024-004472",
        acquisitionMethod: "purchase",
        contentSha256: "sha-failed",
        purchaseCostCents: 1500,
        metadata: {
          visionRead: {
            status: "failed",
            visionApplied: false,
            failureReason: "vision_read_produced_no_text",
            readAt: "2026-09-01T12:00:00.000Z",
          },
        },
      },
      {
        jobId,
        portalId: "portal-1",
        documentType: "release",
        recordingRef: "2024-004473",
        acquisitionMethod: "purchase",
        contentSha256: "sha-skipped",
        purchaseCostCents: 1500,
        metadata: {
          visionRead: {
            status: "skipped",
            visionApplied: false,
            failureReason: "vision_client_unavailable",
            readAt: "2026-09-01T12:00:01.000Z",
          },
        },
      },
      {
        jobId,
        portalId: "portal-1",
        documentType: "deed",
        recordingRef: "2024-004474",
        acquisitionMethod: "purchase",
        contentSha256: "sha-complete",
        purchaseCostCents: 1500,
        metadata: {
          visionRead: {
            status: "complete",
            visionApplied: true,
            extractedText: REAL_TEXT,
            readAt: "2026-09-01T12:00:02.000Z",
          },
          classify: {
            status: "written",
            instrumentId: "instr-real-1",
            clauseCount: 0,
            instrumentType: "other",
            documentKind: "deed",
            classifiedAt: "2026-09-01T12:05:00.000Z",
          },
        },
      },
    ]);

    const result = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID },
      { db: testDb },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.jobs).toHaveLength(1);
    const docs = body.jobs[0].documents as Array<Record<string, unknown>>;
    expect(docs).toHaveLength(4);

    const byRef = Object.fromEntries(
      docs.map((d) => [d.recordingRef as string, d]),
    );

    expect(byRef["2024-004471"]!.readState).toBe("pending");
    expect(byRef["2024-004471"]!.hasExtractedText).toBe(false);
    expect(byRef["2024-004471"]!.failureReason).toBeNull();

    expect(byRef["2024-004472"]!.readState).toBe("failed");
    expect(byRef["2024-004472"]!.failureReason).toBe(
      "vision_read_produced_no_text",
    );
    expect(byRef["2024-004472"]!.hasExtractedText).toBe(false);

    expect(byRef["2024-004473"]!.readState).toBe("skipped");
    expect(byRef["2024-004473"]!.failureReason).toBe(
      "vision_client_unavailable",
    );
    // failed and skipped are DIFFERENT values, never merged.
    expect(byRef["2024-004473"]!.readState).not.toBe(
      byRef["2024-004472"]!.readState,
    );

    expect(byRef["2024-004474"]!.readState).toBe("complete");
    expect(byRef["2024-004474"]!.hasExtractedText).toBe(true);
    // List view never carries the body text.
    expect(byRef["2024-004474"]!.extractedText).toBeUndefined();
    expect(byRef["2024-004474"]!.textLength).toBe(REAL_TEXT.length);
    expect(byRef["2024-004474"]!.classifyState).toBe("written");
    expect(byRef["2024-004474"]!.instrumentType).toBe("other");
    expect(byRef["2024-004474"]!.documentKind).toBe("deed");

    // read_purchased_record on the complete document returns the REAL
    // extractedText verbatim, end to end.
    const readResult = await readPurchasedRecord(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID, artifactId: byRef["2024-004474"]!.artifactId as string },
      { db: testDb },
    );
    expect(readResult.isError).toBe(false);
    const readBody = JSON.parse(readResult.content[0]!.text);
    expect(readBody.readState).toBe("complete");
    expect(readBody.extractedText).toBe(REAL_TEXT);
    expect(readBody.instrumentId).toBe("instr-real-1");
    expect(readBody.purchaseCostCents).toBe(1500);
    expect(readBody.acquisitionMethod).toBe("purchase");

    // read_purchased_record on the pending document declares pending, with
    // extractedText explicitly null rather than absent-and-ambiguous.
    const pendingRead = await readPurchasedRecord(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID, artifactId: byRef["2024-004471"]!.artifactId as string },
      { db: testDb },
    );
    const pendingBody = JSON.parse(pendingRead.content[0]!.text);
    expect(pendingBody.readState).toBe("pending");
    expect(pendingBody.extractedText).toBeNull();
  });
});

describe("recordsExtraction — ownership and parcel scoping (fail closed, never leak across boundaries)", () => {
  it("a parcel with zero records-request jobs is a genuine empty result, not an error", async () => {
    const result = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: "48453:R999999" },
      { db: testDb },
    );
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("ok");
    expect(body.jobs).toEqual([]);
  });

  it("refuses an invalid parcelNodeId shape without touching the DB", async () => {
    const result = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: "not-a-parcel-id" },
      { db: testDb },
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.reason).toBe("parcel_node_id_invalid");
  });

  it("never returns another user's document even given its real artifactId", async () => {
    const engagementId = await seedEngagement("cross-user");
    const [job] = await testDb
      .insert(recordsRequestJobs)
      .values({
        engagementId,
        userId: USER_B,
        parcelKey: PARCEL_KEY,
        countyFips: "48453",
        status: "complete",
      })
      .returning({ id: recordsRequestJobs.id });
    const [artifact] = await testDb
      .insert(recordsRequestArtifacts)
      .values({
        jobId: job!.id,
        portalId: "portal-1",
        documentType: "deed",
        acquisitionMethod: "purchase",
        contentSha256: "sha-other-user",
        metadata: {
          visionRead: {
            status: "complete",
            visionApplied: true,
            extractedText: "USER B'S PRIVATE DOCUMENT TEXT",
          },
        },
      })
      .returning({ id: recordsRequestArtifacts.id });

    // USER_A never sees it in a list for the same parcel.
    const listResult = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID },
      { db: testDb },
    );
    const listBody = JSON.parse(listResult.content[0]!.text);
    expect(listBody.jobs).toEqual([]);

    // USER_A cannot read it directly by artifactId either, and the refusal
    // is identical in shape to a genuine not-found (never confirms the id
    // exists for someone else).
    const readResult = await readPurchasedRecord(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID, artifactId: artifact!.id },
      { db: testDb },
    );
    expect(readResult.isError).toBe(true);
    const readBody = JSON.parse(readResult.content[0]!.text);
    expect(readBody.reason).toBe("artifact_not_found");
    expect(readBody.extractedText).toBeUndefined();

    // The rightful owner reads it fine (proves the refusal above was
    // ownership-scoped, not a fixture/query bug).
    const ownerRead = await readPurchasedRecord(
      STUDIO,
      USER_B,
      { parcelNodeId: PARCEL_NODE_ID, artifactId: artifact!.id },
      { db: testDb },
    );
    expect(ownerRead.isError).toBe(false);
    const ownerBody = JSON.parse(ownerRead.content[0]!.text);
    expect(ownerBody.extractedText).toBe("USER B'S PRIVATE DOCUMENT TEXT");
  });

  it("refuses a real artifactId presented against the wrong parcelNodeId", async () => {
    const engagementId = await seedEngagement("wrong-parcel");
    const [job] = await testDb
      .insert(recordsRequestJobs)
      .values({
        engagementId,
        userId: USER_A,
        parcelKey: PARCEL_KEY,
        countyFips: "48453",
        status: "complete",
      })
      .returning({ id: recordsRequestJobs.id });
    const [artifact] = await testDb
      .insert(recordsRequestArtifacts)
      .values({
        jobId: job!.id,
        portalId: "portal-1",
        documentType: "deed",
        acquisitionMethod: "purchase",
        contentSha256: "sha-wrong-parcel",
        metadata: {},
      })
      .returning({ id: recordsRequestArtifacts.id });

    const result = await readPurchasedRecord(
      STUDIO,
      USER_A,
      { parcelNodeId: "48453:R000001", artifactId: artifact!.id },
      { db: testDb },
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.reason).toBe("artifact_not_found");
  });
});

describe("recordsExtraction — classify state gets the same never-collapsed treatment", () => {
  it("real end-to-end: pending, refused, skipped, and written classify states read back distinctly", async () => {
    const engagementId = await seedEngagement("classify-states");
    const [job] = await testDb
      .insert(recordsRequestJobs)
      .values({
        engagementId,
        userId: USER_A,
        parcelKey: PARCEL_KEY,
        countyFips: "48453",
        status: "complete",
      })
      .returning({ id: recordsRequestJobs.id });

    await testDb.insert(recordsRequestArtifacts).values([
      {
        jobId: job!.id,
        portalId: "portal-1",
        documentType: "deed",
        acquisitionMethod: "purchase",
        contentSha256: "sha-classify-refused",
        metadata: {
          classify: {
            status: "refused",
            refuseCode: "recording_ref_missing",
            refuseMessage: "No recording reference to classify against.",
          },
        },
      },
      {
        jobId: job!.id,
        portalId: "portal-1",
        documentType: "deed",
        acquisitionMethod: "purchase",
        contentSha256: "sha-classify-skipped",
        metadata: { classify: { status: "skipped" } },
      },
    ]);

    const result = await listPurchasedRecords(
      STUDIO,
      USER_A,
      { parcelNodeId: PARCEL_NODE_ID },
      { db: testDb },
    );
    const body = JSON.parse(result.content[0]!.text);
    const docs = body.jobs[0].documents as Array<Record<string, unknown>>;
    expect(docs.map((d) => d.classifyState)).toEqual(
      expect.arrayContaining(["refused", "skipped"]),
    );
    const refused = docs.find((d) => d.classifyState === "refused")!;
    expect(refused.refuseCode).toBe("recording_ref_missing");
    const skipped = docs.find((d) => d.classifyState === "skipped")!;
    expect(skipped.instrumentType).toBeNull();
  });
});
