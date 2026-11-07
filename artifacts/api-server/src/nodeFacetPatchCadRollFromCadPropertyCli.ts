#!/usr/bin/env node
/**
 * Wave R dollar-fields patch: stamp cad_property values onto existing
 * place_layer_snapshots. Does not rebuild zoning / envelope / land use.
 * NEVER reads cad-parcel-roll atoms.
 *
 * Usage: --county=<fips> [--dry-run] [--prop-ids=a.b.c] [--page-size=2000]
 *        [--blast-radius-override=<token>]
 * Env: DATABASE_URL (or DEPLOYMENT_DATABASE_URL). neondb only.
 *
 * GATE 4 / P4 (audit 2026-10-07, "node-facet-patch-cad-roll" named in the
 * gate-5 onboarding-runbook item): this UPDATEs every matched row for a
 * county with no cap. Before this gate there was no measured population and
 * no refusal of any kind -- the exact class of gap the audit's Robertson/
 * Smith repairs fell through (one touched 95.67% of a county with no
 * review). It is now a TWO-PASS run: pass 1 measures, against
 * MAX_DESTRUCTIVE_SHARE (0.05, the same program-wide number hauska-engine
 * and hauska-factory declare), how many rows would have an EXISTING,
 * already-answered cadRoll field (`marketValue`/`assessedValue`/`landValue`
 * /`improvementValue`/`livingAreaSqft`) CHANGE to a different value --
 * never the total rows touched, which on a first-ever patch (every field
 * starts absent) is always 0 by construction and never refuses a county's
 * first onboarding. Pass 2 writes only if pass 1's measured share clears
 * the threshold (or an exact `--blast-radius-override` token authorizes
 * this measured run). See `destructiveWriteGuard.ts`.
 */
import { fileURLToPath } from "node:url";
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import { contentHashForPayload } from "./lib/placeLayerUtils.js";
import { fetchCountyCadPropertyRoll, type CountyCadPropertyRoll } from "./lib/joinIntegrityGate.js";
import {
  applyCadPropertyFactsToPayload,
  cadPropertyFactsFromRow,
  type CadRollBaked,
} from "./lib/cadRollValue.js";
import {
  AUTHORISATION_ENV_VAR,
  BlastRadiusRefusal,
  evaluateBlastRadius,
} from "./lib/destructiveWriteGuard.js";

const DEFAULT_PAGE = 2000;
const WRITER = "node-facet-patch-cad-roll";

function parseArgs(argv: string[]) {
  const county = argv.find((a) => a.startsWith("--county="))?.split("=")[1];
  if (!county || !/^\d{5}$/.test(county)) {
    throw new Error("usage: --county=<5-digit fips> [--dry-run] [--prop-ids=a.b.c]");
  }
  const dryRun = argv.includes("--dry-run");
  const propIdsRaw = argv.find((a) => a.startsWith("--prop-ids="))?.split("=")[1];
  const propIds = propIdsRaw
    ? propIdsRaw.split(/[.|+]/).map((s) => s.trim()).filter(Boolean)
    : null;
  const pageSizeRaw = argv.find((a) => a.startsWith("--page-size="))?.split("=")[1];
  const pageSize =
    pageSizeRaw && Number.isFinite(Number(pageSizeRaw)) && Number(pageSizeRaw) > 0
      ? Number(pageSizeRaw)
      : DEFAULT_PAGE;
  const blastRadiusOverride =
    argv.find((a) => a.startsWith("--blast-radius-override="))?.split("=").slice(1).join("=") ?? null;
  return { county, dryRun, propIds, pageSize, blastRadiusOverride };
}

type SnapshotPageRow = {
  place_key: string;
  payload_json: Record<string, unknown>;
};

const CAD_ROLL_FIELDS = [
  "marketValue",
  "assessedValue",
  "landValue",
  "improvementValue",
  "livingAreaSqft",
] as const;

/**
 * True when ANY cadRoll field that was already answered (non-null) would
 * change to a different value. Exported for a direct unit test
 * (destructiveOverwrite.test.ts); this module's `main()` is gated below on
 * a direct-run check so importing it for this function alone never also
 * opens a DB pool or calls `process.exit`.
 */
export function isDestructiveOverwrite(
  oldCadRoll: Partial<CadRollBaked> | null | undefined,
  newCadRoll: CadRollBaked,
): boolean {
  if (!oldCadRoll) return false;
  for (const field of CAD_ROLL_FIELDS) {
    const before = (oldCadRoll as Record<string, unknown>)[field];
    if (before == null) continue; // was absent — a fill, never an overwrite.
    const after = (newCadRoll as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(before) !== JSON.stringify(after)) return true;
  }
  return false;
}

/** One row's computed patch: the next payload, its content hash, and whether it is destructive. */
function computeRowPatch(
  row: SnapshotPageRow,
  propId: string,
  roll: CountyCadPropertyRoll,
) {
  const cad = roll.consulted ? (roll.byPropId.get(propId) ?? null) : null;
  const facts = cadPropertyFactsFromRow(cad);
  const oldBase =
    row.payload_json.baseFacts && typeof row.payload_json.baseFacts === "object"
      ? (row.payload_json.baseFacts as Record<string, unknown>)
      : null;
  const oldCadRoll = (oldBase?.cadRoll as Partial<CadRollBaked> | null | undefined) ?? null;
  const next = applyCadPropertyFactsToPayload(row.payload_json, facts);
  return {
    cad,
    facts,
    next,
    destructive: isDestructiveOverwrite(oldCadRoll, facts.cadRoll),
  };
}

/**
 * One full paginated scan over the county's rows. `onRow` is called for every row IN SCOPE
 * (after the --prop-ids filter); it never issues a write itself. Returns nothing — callers
 * accumulate whatever they need via `onRow`'s side effects, so pass 1 (measure) and pass 2
 * (write) share this exact traversal and can never drift against each other on which rows
 * are in scope.
 */
async function scanCounty(
  neondb: pg.Pool,
  prefix: string,
  propIds: string[] | null,
  pageSize: number,
  onRow: (row: SnapshotPageRow, propId: string) => Promise<void> | void,
): Promise<void> {
  let afterKey: string | null = null;
  for (;;) {
    const page: pg.QueryResult<SnapshotPageRow> = await neondb.query<SnapshotPageRow>(
      `SELECT place_key, payload_json
         FROM place_layer_snapshots
        WHERE adapter_key = $1
          AND place_key LIKE $2
          AND ($3::text IS NULL OR place_key > $3)
        ORDER BY place_key
        LIMIT $4`,
      [TIER1_ADAPTER_KEY, `${prefix}%`, afterKey, pageSize],
    );
    if (page.rows.length === 0) break;
    afterKey = page.rows[page.rows.length - 1]!.place_key;
    for (const row of page.rows) {
      const propId = row.place_key.slice(prefix.length);
      if (propIds && !propIds.includes(propId)) continue;
      await onRow(row, propId);
    }
  }
}

async function main() {
  const { county, dryRun, propIds, pageSize, blastRadiusOverride } = parseArgs(process.argv.slice(2));
  const neondbUrl = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!neondbUrl) throw new Error("DATABASE_URL required");
  const neondb = new pg.Pool({
    connectionString: neondbUrl,
    ssl: { rejectUnauthorized: true },
    max: 2,
  });

  const dbName = await neondb.query("SELECT current_database() AS db, now() AS ts");
  const roll = await fetchCountyCadPropertyRoll(neondb, county);
  const prefix = `node:${county}:`;

  let scanned = 0;
  let destructive = 0;
  let noCadRow = 0;
  let marketPresent = 0;
  let improvementZero = 0;
  let livingPresent = 0;
  let yearPresent = 0;
  let legalPresent = 0;
  let assessedPresent = 0;

  // ---- PASS 1: MEASURE ONLY. No write happens in this pass, in dry-run or not.
  await scanCounty(neondb, prefix, propIds, pageSize, (row, propId) => {
    scanned += 1;
    const { cad, facts, destructive: isDestructive } = computeRowPatch(row, propId, roll);
    if (!cad) noCadRow += 1;
    if (facts.cadRoll.marketValue && facts.cadRoll.marketValue.v > 0) marketPresent += 1;
    if (facts.cadRoll.assessedValue != null) assessedPresent += 1;
    if (facts.cadRoll.improvementValue?.v === 0) improvementZero += 1;
    if (facts.cadRoll.livingAreaSqft) livingPresent += 1;
    if (facts.yearBuilt) yearPresent += 1;
    if (facts.legalDescription) legalPresent += 1;
    if (isDestructive) destructive += 1;
  });

  // ---- GATE 4 / P4: BEFORE any write, in BOTH dry-run and a real run (dry-run predicts the
  // refusal too, same rule hauska-engine's blast-radius and corroboration gates follow).
  const blastRadius = evaluateBlastRadius({
    writer: WRITER,
    scopeKey: county,
    affected: destructive,
    population: scanned,
    override: blastRadiusOverride ?? process.env[AUTHORISATION_ENV_VAR] ?? null,
  });

  let patched = 0;
  if (!dryRun) {
    // ---- PASS 2: WRITE. Re-scans the SAME traversal; nothing here can write a row pass 1
    // did not already count into `scanned`/`destructive` above the gate.
    await scanCounty(neondb, prefix, propIds, pageSize, async (row, propId) => {
      const { next } = computeRowPatch(row, propId, roll);
      await neondb.query(
        `UPDATE place_layer_snapshots AS s
            SET payload_json = $2::jsonb,
                content_hash = $3,
                snapshot_at = now(),
                updated_at = now()
          WHERE s.adapter_key = $4
            AND s.place_key = $1`,
        [row.place_key, JSON.stringify(next), contentHashForPayload(next), TIER1_ADAPTER_KEY],
      );
      patched += 1;
    });
  } else {
    // Dry-run: "patched" reports the would-write count (every in-scope row), same as before this gate.
    patched = scanned;
  }

  console.log(
    JSON.stringify({
      county,
      dryRun,
      current_database: dbName.rows[0].db,
      ts: dbName.rows[0].ts,
      cadPropertyConsulted: roll.consulted,
      cadPropertyRows: roll.byPropId.size,
      declaredTaxYear: roll.declaredTaxYear,
      scanned,
      patched,
      destructive,
      blastRadius,
      noCadRow,
      marketPresent,
      assessedPresent,
      improvementZero,
      livingPresent,
      yearPresent,
      legalPresent,
    }),
  );
  await neondb.end();
}

// Direct-run guard: `tsx src/nodeFacetPatchCadRollFromCadPropertyCli.ts` sets
// process.argv[1] to THIS file's path. A test importing this module for
// `isDestructiveOverwrite` runs under vitest's own entry instead, so this
// stays false there and main() never opens a DB pool or calls process.exit
// as a side effect of the import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (err instanceof BlastRadiusRefusal) {
      console.error(JSON.stringify({ event: "node-facet-patch-cad-roll.refused", code: err.code, message: err.message, detail: err.detail }));
      process.exit(2);
    }
    console.error(err.code || err.message);
    process.exit(1);
  });
}
