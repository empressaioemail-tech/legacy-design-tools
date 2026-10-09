/**
 * `swapStagedCounty` (P-499, OPS-16 A-382/A-383; `sourceFeatureSwap.ts`).
 *
 * Runs migration `0111_source_feature.sql` directly against the per-test
 * schema rather than relying on the committed
 * `__fixtures__/schema.sql.template` replay, because that fixture can only
 * be regenerated against a real Postgres with BOTH postgis and pgvector
 * (`pnpm --filter @workspace/db run test:fixture:schema`) and this card's
 * own report says whether that happened. The migration's `CREATE TABLE IF
 * NOT EXISTS` makes this safe either way: once the fixture does carry
 * `source_feature`/`source_feature_stage`, re-applying the same DDL here
 * is a no-op.
 *
 * `source_feature` is list-partitioned on `provider` with ZERO partitions
 * committed (migration 0111's header: a card that only lands the shape,
 * not a loader). A list-partitioned table with no matching partition
 * refuses every insert, so this suite creates and uses its own
 * `test.fixture-provider` partition, scoped to the per-test schema and
 * dropped with it -- never a committed migration, per the assignment's
 * "do not create any provider partitions yet beyond what tests need".
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  swapStagedCounty,
  SourceFeatureSwapEmptyStageError,
  SourceFeatureSwapCountMismatchError,
} from "../../sourceFeatureSwap";
import { sourceFeature } from "../../schema/sourceFeature";
import { sourceFeatureStage } from "../../schema/sourceFeatureStage";
import { withTestSchema } from "../../testing";
import type { TestSchemaContext } from "../../testing";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "drizzle",
  "0111_source_feature.sql",
);

const PROVIDER = "test.fixture-provider";
const OTHER_PROVIDER = "test.fixture-provider-2";
const COUNTY = "48053"; // Burnet
const OTHER_COUNTY = "48491"; // Williamson

/**
 * Applies migration 0111 (idempotent via `CREATE TABLE IF NOT EXISTS`) and
 * creates the test-only partitions this suite needs, scoped to `ctx`'s
 * schema via its pre-configured `search_path`.
 */
async function setUpSourceFeatureTables(ctx: TestSchemaContext): Promise<void> {
  const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
  await ctx.pool.query(migrationSql);
  await ctx.pool.query(
    `CREATE TABLE IF NOT EXISTS "source_feature_test_fixture_provider" ` +
      `PARTITION OF "source_feature" FOR VALUES IN ('${PROVIDER}')`,
  );
  await ctx.pool.query(
    `CREATE TABLE IF NOT EXISTS "source_feature_test_fixture_provider_2" ` +
      `PARTITION OF "source_feature" FOR VALUES IN ('${OTHER_PROVIDER}')`,
  );
}

function stageRow(overrides: {
  provider?: string;
  countyFips?: string;
  providerObjectId: string;
  loadRunId: string;
}) {
  return {
    provider: overrides.provider ?? PROVIDER,
    providerObjectId: overrides.providerObjectId,
    stateFips: "48",
    countyFips: overrides.countyFips ?? COUNTY,
    vintage: "2026-fixture",
    fetchedAt: new Date("2026-10-09T00:00:00Z"),
    loadRunId: overrides.loadRunId,
    sourceUrl: "https://example.test/fixture",
    payload: { fixture: true },
  };
}

function liveRow(overrides: {
  provider?: string;
  countyFips?: string;
  providerObjectId: string;
  loadRunId: string;
}) {
  return stageRow(overrides);
}

describe("swapStagedCounty", () => {
  it("refuses SOURCE_FEATURE_SWAP_EMPTY_STAGE when the stage has zero rows for (provider, county, loadRunId), and touches nothing", async () => {
    await withTestSchema(async (ctx) => {
      await setUpSourceFeatureTables(ctx);

      await ctx.db.insert(sourceFeature).values(
        liveRow({ providerObjectId: "live-1", loadRunId: "run-old" }),
      );

      await expect(
        swapStagedCounty(ctx.db, {
          provider: PROVIDER,
          countyFips: COUNTY,
          loadRunId: "run-empty",
          expectedCount: 1,
        }),
      ).rejects.toBeInstanceOf(SourceFeatureSwapEmptyStageError);

      // Live row for the county is untouched.
      const live = await ctx.db
        .select()
        .from(sourceFeature)
        .where(
          and(eq(sourceFeature.provider, PROVIDER), eq(sourceFeature.countyFips, COUNTY)),
        );
      expect(live).toHaveLength(1);
      expect(live[0].providerObjectId).toBe("live-1");
    });
  });

  it("refuses SOURCE_FEATURE_SWAP_COUNT_MISMATCH when the staged count does not match expectedCount, and touches nothing", async () => {
    await withTestSchema(async (ctx) => {
      await setUpSourceFeatureTables(ctx);

      await ctx.db.insert(sourceFeature).values(
        liveRow({ providerObjectId: "live-1", loadRunId: "run-old" }),
      );
      await ctx.db.insert(sourceFeatureStage).values([
        stageRow({ providerObjectId: "stage-1", loadRunId: "run-mismatch" }),
        stageRow({ providerObjectId: "stage-2", loadRunId: "run-mismatch" }),
      ]);

      await expect(
        swapStagedCounty(ctx.db, {
          provider: PROVIDER,
          countyFips: COUNTY,
          loadRunId: "run-mismatch",
          expectedCount: 5, // stage actually has 2
        }),
      ).rejects.toMatchObject({
        code: "SOURCE_FEATURE_SWAP_COUNT_MISMATCH",
        expectedCount: 5,
        actualCount: 2,
      });

      // Live row is untouched...
      const live = await ctx.db
        .select()
        .from(sourceFeature)
        .where(
          and(eq(sourceFeature.provider, PROVIDER), eq(sourceFeature.countyFips, COUNTY)),
        );
      expect(live).toHaveLength(1);
      expect(live[0].providerObjectId).toBe("live-1");

      // ...and the staged rows are KEPT for diagnosis, not dropped.
      const staged = await ctx.db
        .select()
        .from(sourceFeatureStage)
        .where(
          and(
            eq(sourceFeatureStage.provider, PROVIDER),
            eq(sourceFeatureStage.countyFips, COUNTY),
            eq(sourceFeatureStage.loadRunId, "run-mismatch"),
          ),
        );
      expect(staged).toHaveLength(2);
    });
  });

  it("swaps atomically on a matching count: live rows replaced wholesale, stage cleared for that run", async () => {
    await withTestSchema(async (ctx) => {
      await setUpSourceFeatureTables(ctx);

      // Two OLD live rows for this county, under an earlier run.
      await ctx.db.insert(sourceFeature).values([
        liveRow({ providerObjectId: "old-1", loadRunId: "run-old" }),
        liveRow({ providerObjectId: "old-2", loadRunId: "run-old" }),
      ]);
      // Three NEW staged rows under the run being swapped in.
      await ctx.db.insert(sourceFeatureStage).values([
        stageRow({ providerObjectId: "new-1", loadRunId: "run-new" }),
        stageRow({ providerObjectId: "new-2", loadRunId: "run-new" }),
        stageRow({ providerObjectId: "new-3", loadRunId: "run-new" }),
      ]);

      const result = await swapStagedCounty(ctx.db, {
        provider: PROVIDER,
        countyFips: COUNTY,
        loadRunId: "run-new",
        expectedCount: 3,
      });

      expect(result).toEqual({
        provider: PROVIDER,
        countyFips: COUNTY,
        loadRunId: "run-new",
        deletedLiveCount: 2,
        insertedCount: 3,
      });

      const live = await ctx.db
        .select()
        .from(sourceFeature)
        .where(
          and(eq(sourceFeature.provider, PROVIDER), eq(sourceFeature.countyFips, COUNTY)),
        );
      expect(live.map((r) => r.providerObjectId).sort()).toEqual([
        "new-1",
        "new-2",
        "new-3",
      ]);
      // The old run's rows are gone (whole-county replace), not merged.
      expect(live.every((r) => r.loadRunId === "run-new")).toBe(true);

      const staged = await ctx.db
        .select()
        .from(sourceFeatureStage)
        .where(
          and(
            eq(sourceFeatureStage.provider, PROVIDER),
            eq(sourceFeatureStage.countyFips, COUNTY),
            eq(sourceFeatureStage.loadRunId, "run-new"),
          ),
        );
      expect(staged).toHaveLength(0);
    });
  });

  it("a DIFFERENT county's live rows are untouched by a swap on this county, success or refusal", async () => {
    await withTestSchema(async (ctx) => {
      await setUpSourceFeatureTables(ctx);

      await ctx.db.insert(sourceFeature).values(
        liveRow({ countyFips: OTHER_COUNTY, providerObjectId: "other-county-1", loadRunId: "run-other" }),
      );
      await ctx.db.insert(sourceFeatureStage).values(
        stageRow({ providerObjectId: "new-1", loadRunId: "run-new" }),
      );

      await swapStagedCounty(ctx.db, {
        provider: PROVIDER,
        countyFips: COUNTY,
        loadRunId: "run-new",
        expectedCount: 1,
      });

      const otherCountyRows = await ctx.db
        .select()
        .from(sourceFeature)
        .where(
          and(
            eq(sourceFeature.provider, PROVIDER),
            eq(sourceFeature.countyFips, OTHER_COUNTY),
          ),
        );
      expect(otherCountyRows).toHaveLength(1);
      expect(otherCountyRows[0].providerObjectId).toBe("other-county-1");
    });
  });

  it("rejects malformed arguments before touching the database", async () => {
    await withTestSchema(async (ctx) => {
      await setUpSourceFeatureTables(ctx);
      await expect(
        swapStagedCounty(ctx.db, {
          provider: "",
          countyFips: COUNTY,
          loadRunId: "run-x",
          expectedCount: 1,
        }),
      ).rejects.toThrow(/non-empty provider/);
      await expect(
        swapStagedCounty(ctx.db, {
          provider: PROVIDER,
          countyFips: "TX",
          loadRunId: "run-x",
          expectedCount: 1,
        }),
      ).rejects.toThrow(/5-digit county_fips/);
      await expect(
        swapStagedCounty(ctx.db, {
          provider: PROVIDER,
          countyFips: COUNTY,
          loadRunId: "",
          expectedCount: 1,
        }),
      ).rejects.toThrow(/non-empty loadRunId/);
      await expect(
        swapStagedCounty(ctx.db, {
          provider: PROVIDER,
          countyFips: COUNTY,
          loadRunId: "run-x",
          expectedCount: -1,
        }),
      ).rejects.toThrow(/non-negative integer expectedCount/);
    });
  });
});
