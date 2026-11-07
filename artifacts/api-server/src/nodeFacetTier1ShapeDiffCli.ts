#!/usr/bin/env node
/**
 * Tier-1 snapshot SHAPE DIFF (read-only instrument, OPS-19 A-025 / CTX card E).
 *
 * Reads `place_layer_snapshots` rows by (adapter_key, place_key) only and
 * reports, per parcel, which of the old bake's facet key paths are MISSING
 * from the stored payload (`REQUIRED_TIER1_FACET_PATHS`, key-exists
 * semantics: `zoning: null` satisfies `zoning`; an omitted key does not) and
 * which root keys are neither required, ignored nor allowlisted. With
 * `--reference=<parcelNodeId>` it also compares every LEAF of that live
 * old-shape row against each parcel (strict).
 *
 * Exit 1 when any parcel is missing a required path (or any reference leaf),
 * so the negative case is a real exit code. Never writes. Never prints the
 * connection string.
 *
 * Usage:
 *   DATABASE_URL=<neondb> tsx src/nodeFacetTier1ShapeDiffCli.ts \
 *     --parcels=48021:34137+48021:34729 [--reference=48021:8704664] \
 *     [--adapter-key=node-facets:tier1] [--self-test]
 *
 * `--self-test` runs the instrument against a thinned in-memory payload and
 * exits 1 when it fails to detect the thinning (an instrument observed only
 * passing has not been observed working).
 */
import pg from "pg";
import { TIER1_ADAPTER_KEY } from "./lib/nodeFacetTier1Constants.js";
import {
  diffAgainstRequiredFacetPaths,
  diffTier1KeyPaths,
  REQUIRED_TIER1_FACET_PATHS,
} from "./lib/nodeFacetBakeTier1Conformant.js";

function arg(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`${name}=`))?.split("=").slice(1).join("=");
}

function selfTest(): number {
  const full: Record<string, unknown> = {};
  for (const p of REQUIRED_TIER1_FACET_PATHS) {
    const parts = p.split(".");
    let cur: Record<string, unknown> = full;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]!] = (cur[parts[i]!] as Record<string, unknown> | undefined) ?? {};
      cur = cur[parts[i]!] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = null;
  }
  const pass = diffAgainstRequiredFacetPaths(full);
  const thinned = { ...full } as Record<string, unknown>;
  delete thinned.zoning;
  delete thinned.envelope;
  const fail = diffAgainstRequiredFacetPaths(thinned);
  const ok = pass.missing.length === 0 && fail.missing.length === 2;
  console.log(
    JSON.stringify({
      selfTest: ok ? "pass" : "FAIL",
      fullShapeMissing: pass.missing,
      thinnedMissing: fail.missing,
    }),
  );
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();
  const parcelsRaw = arg(argv, "--parcels");
  if (!parcelsRaw) throw new Error("--parcels=<id+id+...> required");
  const parcels = parcelsRaw.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
  const reference = arg(argv, "--reference")?.trim() || null;
  const adapterKey = arg(argv, "--adapter-key")?.trim() || TIER1_ADAPTER_KEY;
  const url = process.env.DATABASE_URL ?? process.env.DSN;
  if (!url) throw new Error("DATABASE_URL (or DSN) required");

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await client.connect();
  let exitCode = 0;
  try {
    await client.query("set statement_timeout = 30000");
    const keys = [...parcels, ...(reference ? [reference] : [])].map((p) => `node:${p}`);
    const { rows } = await client.query<{
      place_key: string;
      snapshot_at: Date | string | null;
      payload_json: unknown;
    }>(
      `SELECT place_key, snapshot_at, payload_json
         FROM place_layer_snapshots
        WHERE adapter_key = $1 AND place_key = ANY($2::text[])`,
      [adapterKey, keys],
    );
    const byKey = new Map(rows.map((r) => [r.place_key, r]));
    const refRow = reference ? byKey.get(`node:${reference}`) : undefined;
    if (reference && !refRow) {
      console.log(JSON.stringify({ reference, found: false }));
      exitCode = 1;
    }
    let withMissing = 0;
    let found = 0;
    for (const parcel of parcels) {
      const row = byKey.get(`node:${parcel}`);
      if (!row) {
        console.log(JSON.stringify({ parcelNodeId: parcel, found: false }));
        continue;
      }
      found += 1;
      const payload = row.payload_json as Record<string, unknown> | null;
      const facetDiff = diffAgainstRequiredFacetPaths(payload);
      const line: Record<string, unknown> = {
        parcelNodeId: parcel,
        found: true,
        adapterKey,
        snapshotAt:
          row.snapshot_at instanceof Date ? row.snapshot_at.toISOString() : row.snapshot_at,
        shapeSource: payload?.shapeSource ?? null,
        facetSchemaVersion: payload?.facetSchemaVersion ?? null,
        requiredPresent: `${facetDiff.present}/${facetDiff.required}`,
        missing: facetDiff.missing,
        unexpectedRoots: facetDiff.unexpectedRoots,
      };
      let bad = facetDiff.missing.length > 0;
      if (refRow) {
        const leafDiff = diffTier1KeyPaths(refRow.payload_json, payload);
        line.referenceParcel = reference;
        line.referenceLeafDiff = {
          missing: leafDiff.missing,
          unexpected: leafDiff.unexpected,
          oldLeafCount: leafDiff.oldLeafCount,
          newLeafCount: leafDiff.newLeafCount,
        };
        if (leafDiff.missing.length > 0) bad = true;
      }
      if (bad) withMissing += 1;
      console.log(JSON.stringify(line));
    }
    const verdict = withMissing === 0 && found === parcels.length ? "pass" : "fail";
    console.log(
      JSON.stringify({
        summary: true,
        adapterKey,
        parcels: parcels.length,
        found,
        withMissing,
        requiredPaths: REQUIRED_TIER1_FACET_PATHS.length,
        verdict,
      }),
    );
    if (verdict !== "pass") exitCode = 1;
  } finally {
    await client.end();
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err.code || err.message);
    process.exit(2);
  });
