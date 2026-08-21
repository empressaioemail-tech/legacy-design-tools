#!/usr/bin/env node
/**
 * R-09 proof-by-firing: read-only against deployment Postgres.
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import {
  effectiveRailFieldsByKey,
  manifestReadProbeOptions,
  readManifestGridFromPool,
} from "../src/manifest.ts";
import { applyDepthRailDisplayGate } from "../src/manifestGridRead.ts";
import {
  resolveManifestDisplayState,
  resolveManifestIsPartial,
} from "../src/manifestCellResolve.ts";
import { COVERAGE_CLASS_BY_RAIL_KEY } from "../src/schema/countyRailDimension.ts";

const { Pool } = pg;

function resolveDatabaseUrl() {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return direct;
  const gcloud =
    process.env.GCLOUD_BIN ??
    (process.platform === "win32"
      ? "C:\\Users\\cente\\AppData\\Local\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd"
      : "gcloud");
  return execFileSync(
    gcloud,
    [
      "secrets",
      "versions",
      "access",
      "latest",
      "--secret=DEPLOYMENT_DATABASE_URL",
      `--project=${process.env.GCP_PROJECT ?? "legacy-design-tools-prod"}`,
    ],
    { encoding: "utf8" },
  ).trim();
}

function legacyMapRow(row, num) {
  const honestCoveragePct = num(row.honest_coverage_pct);
  const thresholdPct = num(row.cell_threshold ?? row.rail_default_threshold);
  const cell = {
    countyFips: row.county_fips,
    railKey: row.rail_key,
    displayState: row.display_state,
    isPartial: Boolean(row.is_partial),
    honestCoveragePct,
    thresholdPct,
    hasWriter: Boolean(row.has_writer),
    atomFamilyState: row.atom_family_state,
    verifiedByInstrument: row.verified_by_instrument ?? null,
  };
  if (COVERAGE_CLASS_BY_RAIL_KEY[cell.railKey] === "jurisdiction-depth") {
    if (
      cell.displayState === "satisfied-present" &&
      (cell.honestCoveragePct === null ||
        cell.thresholdPct === null ||
        cell.honestCoveragePct < cell.thresholdPct)
    ) {
      cell.displayState = "not-yet";
      cell.isPartial = false;
    }
  }
  return cell;
}

function summarize(cells, label) {
  const hw = {};
  const afs = {};
  const ip = {};
  for (const c of cells) {
    hw[c.hasWriter] = (hw[c.hasWriter] ?? 0) + 1;
    afs[c.atomFamilyState] = (afs[c.atomFamilyState] ?? 0) + 1;
    ip[c.isPartial] = (ip[c.isPartial] ?? 0) + 1;
  }
  console.log(`\n=== ${label} ===`);
  console.log("hasWriter", JSON.stringify(hw));
  console.log("atomFamilyState", JSON.stringify(afs));
  console.log("isPartial", JSON.stringify(ip));
}

async function main() {
  const url = resolveDatabaseUrl();
  const pool = new Pool({
    connectionString: url,
    ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
    max: 2,
  });

  const snapshotAt = (
    await pool.query(
      "SELECT computed_at FROM county_ledger_snapshot WHERE id = 'current' LIMIT 1",
    )
  ).rows[0]?.computed_at;

  const { rows } = await pool.query(`
    SELECT
      m.county_fips,
      r.rail_key,
      r.threshold_pct AS rail_default_threshold,
      r.atom_family_state,
      r.has_writer,
      c.rail_state,
      c.honest_coverage_pct,
      c.threshold_pct AS cell_threshold,
      c.verified_by_instrument,
      CASE
        WHEN r.atom_family_state <> 'present' THEN 'no-atom'
        WHEN r.has_writer = false THEN 'no-writer'
        WHEN c.rail_state IS NULL THEN 'not-yet'
        ELSE c.rail_state
      END AS display_state,
      CASE
        WHEN r.atom_family_state = 'present'
         AND r.has_writer = true
         AND c.rail_state = 'satisfied-present'
         AND c.honest_coverage_pct < COALESCE(c.threshold_pct, r.threshold_pct)
        THEN true
        ELSE false
      END AS is_partial
    FROM county_manifest m
    CROSS JOIN county_rail r
    LEFT JOIN county_facet_coverage c
      ON c.county_fips = m.county_fips AND c.facet = r.rail_key
  `);

  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const effectiveByKey = effectiveRailFieldsByKey(manifestReadProbeOptions());

  const legacy = rows.map((r) => legacyMapRow(r, num));

  const repairedWithAfs = rows.map((row) => {
    const effective = effectiveByKey.get(row.rail_key);
    const atomFamilyState =
      effective?.atomFamilyState ?? row.atom_family_state;
    const hasWriter = effective?.hasWriter ?? Boolean(row.has_writer);
    const honestCoveragePct = num(row.honest_coverage_pct);
    const thresholdPct = num(row.cell_threshold ?? row.rail_default_threshold);
    const displayState = resolveManifestDisplayState(
      atomFamilyState,
      hasWriter,
      row.rail_state,
    );
    let isPartial = resolveManifestIsPartial(
      atomFamilyState,
      hasWriter,
      row.rail_state,
      honestCoveragePct,
      thresholdPct,
    );
    const gated = applyDepthRailDisplayGate({
      countyFips: row.county_fips,
      railKey: row.rail_key,
      displayState,
      isPartial,
      honestCoveragePct,
      thresholdPct,
      hasWriter,
      verifiedByInstrument: row.verified_by_instrument ?? null,
    });
    return { ...gated, atomFamilyState };
  });

  console.log("snapshot computed_at:", snapshotAt);
  console.log("proof run at:", new Date().toISOString());
  console.log("cells:", rows.length);

  summarize(legacy, "LEGACY (store columns + isPartial erased)");
  summarize(repairedWithAfs, "REPAIRED (overlay + isPartial preserved)");

  const hwNeg = repairedWithAfs.filter((c) => c.hasWriter === false);
  const afsNeg = repairedWithAfs.filter((c) => c.atomFamilyState !== "present");
  const ipPos = repairedWithAfs.filter((c) => c.isPartial === true);

  const proof = {
    hasWriter: {
      negativeCount: hwNeg.length,
      sampleCell: hwNeg[0]
        ? `${hwNeg[0].countyFips}:${hwNeg[0].railKey}`
        : null,
      sample: hwNeg[0] ?? null,
    },
    atomFamilyState: {
      negativeCount: afsNeg.length,
      sampleCell: afsNeg[0]
        ? `${afsNeg[0].countyFips}:${afsNeg[0].railKey}`
        : null,
      sample: afsNeg[0] ?? null,
    },
    isPartial: {
      positiveCount: ipPos.length,
      legacyPartialCount: legacy.filter((c) => c.isPartial).length,
      sampleCell: ipPos[0]
        ? `${ipPos[0].countyFips}:${ipPos[0].railKey}`
        : null,
      sample: ipPos[0] ?? null,
    },
  };

  console.log("\n=== PROOF BY FIRING ===");
  console.log(JSON.stringify(proof, null, 2));

  await pool.end();

  const ok =
    proof.hasWriter.negativeCount > 0 &&
    proof.atomFamilyState.negativeCount > 0 &&
    proof.isPartial.positiveCount > 0 &&
    proof.isPartial.positiveCount > proof.isPartial.legacyPartialCount;

  if (!ok) {
    console.error("\nPROOF FAILED");
    process.exit(1);
  }
  console.log("\nPROOF OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
