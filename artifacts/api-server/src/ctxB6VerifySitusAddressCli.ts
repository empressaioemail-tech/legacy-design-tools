#!/usr/bin/env node
/**
 * P-124 CTX-B6 verification instrument: does the situsAddress leaf change
 * anything, on the real rows, graded by the real grader.
 *
 * VERIFY BY VIOLATING, and the "before" is not a reconstruction. For each
 * named parcel this reads TWO artifacts out of the staging store, read-only:
 *
 *   BEFORE = the payload the pre-change bake actually wrote, verbatim, out of
 *            `place_layer_snapshots` (`node-facets:tier1`). No reimplementation
 *            of old logic, no fixture: the row a customer is served today.
 *   AFTER  = `buildConformantTier1Payload` run HERE, on this checkout, from the
 *            same claim inputs (the claim's raw situsAddress carried on that
 *            same stored payload, plus `cad_property` at the county's declared
 *            vintage for the roll read that decides retirement).
 *
 * Both are graded by the SAME two predicates, reimplemented here VERBATIM from
 * hauska-factory (read 2026-09-10 at origin/main 83c98f97) because this repo
 * cannot import that one:
 *
 *   BP-CONTENT-01 `classifyRequiredLeaf` -- src/jobs/verify-walk.mjs
 *   S1            `isSentinelSitus`      -- src/stages/grade/s-rules.mjs
 *
 * A PASS here means: every named street-less parcel is graded defective BEFORE
 * and clean AFTER, and every named real-street parcel is byte-identical on the
 * leaf. Anything else exits non-zero. It is not a check that can only pass:
 * `--self-test` runs it against synthetic rows including a case the grader must
 * REJECT, so the instrument is observed failing before it is trusted.
 *
 * Usage:
 *   npx tsx src/ctxB6VerifySitusAddressCli.ts --self-test
 *   DATABASE_URL=... npx tsx src/ctxB6VerifySitusAddressCli.ts
 *
 * Read-only: it opens the pool, sets default_transaction_read_only, and never
 * writes. It runs no bake, no publish and no walk.
 */
import pg from "pg";
import {
  buildConformantTier1Payload,
  assertRequiredLeafStatesEarned,
  assertSitusAddressAbsenceEarned,
  isEarnedLeafAbsence,
  isEarnedRecordRetirement,
  resolveConformantSitusAddress,
} from "./lib/nodeFacetBakeTier1Conformant.js";
import {
  classifyRawSitusAddress,
  refusePayloadAtServe,
  situsCarriesStreetComponent,
} from "./lib/serveGuards.js";
import { COUNTY_NAMES } from "./lib/nodeFacetTier1Assemble.js";
import { tryResolveDeclaredCadVintage } from "@workspace/cad-ingest";
import type { CountyCadPropertyRoll } from "./lib/joinIntegrityGate.js";

const ADAPTER_KEY = "node-facets:tier1";
const CANONICAL_ACCESS = { discoverability: "catalog-listed", entitlement: "anyone-free" };

/* ---------------------------------------------------------------------------
 * hauska-factory graders, VERBATIM. Any drift here is a defect in this file.
 * ------------------------------------------------------------------------- */

/** hauska-factory src/stages/grade/s-rules.mjs */
const SENTINEL_EMPTY_COMMAS = /^,\s*,/;
const SENTINEL_STATE_ZIP_ONLY = /^,\s*TX\s+\d{5}/i;
function isSentinelSitus(situs: unknown): boolean {
  if (situs == null) return false;
  const s = String(situs).trim();
  if (s === "") return false;
  return SENTINEL_EMPTY_COMMAS.test(s) || SENTINEL_STATE_ZIP_ONLY.test(s);
}

/** hauska-factory src/jobs/verify-walk.mjs classifyRequiredLeaf, absence half. */
const POPULATED_STATE_TOKENS = ["value", "present", "populated"];
const ABSENCE_STATE_TOKENS = ["absent-verified", "not-applicable", "refused"];
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function classifyRequiredLeaf(
  value: unknown,
  path = "leaf",
): { state: string; ok: boolean; reason?: string } {
  if (value === null || value === undefined) {
    return {
      state: "null",
      ok: false,
      reason: `${path} is null; null is not value|absent-verified|not-applicable|refused`,
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (value === "") return { state: "empty", ok: false, reason: `${path} is empty` };
    return { state: "value", ok: true };
  }
  const rec = asRecord(value);
  if (!rec) return { state: "unknown", ok: false, reason: `${path} is not a four-state leaf` };
  const raw = (rec.verdict ?? rec.state ?? null) as string | null;
  const verdict = raw == null ? null : String(raw).trim();
  if (verdict != null && ABSENCE_STATE_TOKENS.includes(verdict)) {
    const scope = rec.scope ?? rec.scopeSearched;
    const asOf = rec.asOf;
    const basis = rec.basis;
    if (verdict === "absent-verified") {
      for (const [name, v] of [
        ["scope", scope],
        ["asOf", asOf],
        ["basis", basis],
      ] as const) {
        if (v == null || String(v).trim() === "") {
          return { state: verdict, ok: false, reason: `${path} absent-verified missing ${name}` };
        }
      }
    }
    if (verdict === "not-applicable" && (basis == null || String(basis).trim() === "")) {
      return { state: verdict, ok: false, reason: `${path} not-applicable missing basis` };
    }
    return { state: verdict, ok: true };
  }
  if (Object.keys(rec).length === 0) {
    return { state: "empty", ok: false, reason: `${path} is an empty object` };
  }
  if (verdict != null && !POPULATED_STATE_TOKENS.includes(verdict)) {
    return {
      state: "unrecognised-declared-state",
      ok: false,
      reason: `${path} declares ${JSON.stringify(verdict)}, which is not a state we can read`,
    };
  }
  return { state: "value", ok: true };
}

/* ------------------------------------------------------------------------- */

type Verdict = {
  parcelNodeId: string;
  rawClaimSitus: string | null;
  before: { leaf: unknown; content: ReturnType<typeof classifyRequiredLeaf>; sentinel: boolean };
  after: { leaf: unknown; content: ReturnType<typeof classifyRequiredLeaf>; sentinel: boolean };
  expectation: "recovered-from-declared-roll" | "defective-before-clean-after" | "untouched";
  pass: boolean;
  why: string;
};

/**
 * `graded` is the pair of grades a leaf carries. A leaf is DEFECTIVE when
 * BP-CONTENT-01 rejects it (a bare null) OR the S1 family calls it a sentinel
 * (a string with no street). Two independently derived grades, both from the
 * factory, neither this repo's own predicate -- so a fix that only satisfied
 * `classifyRawSitusAddress` would not be able to certify itself here.
 */
function grade(leaf: unknown): { content: ReturnType<typeof classifyRequiredLeaf>; sentinel: boolean } {
  return {
    content: classifyRequiredLeaf(leaf, "baseFacts.situsAddress"),
    sentinel: typeof leaf === "string" ? isSentinelSitus(leaf) : false,
  };
}
const isDefective = (g: { content: { ok: boolean }; sentinel: boolean }): boolean =>
  !g.content.ok || g.sentinel;

/**
 * Build the AFTER payload from the claim the stored row was built from. The
 * claim's own situsAddress is the value the stored payload carries at
 * `baseFacts.situsAddress` when that is a string, and the raw quoted inside
 * the absence's basis when the pre-change bake already earned one.
 */
function afterLeaf(input: {
  parcelNodeId: string;
  countyFips: string;
  rawClaimSitus: string | null;
  /** `cad_property.situs_address` at the county's DECLARED tax_year. */
  rollSitus: string | null;
  claim: Record<string, unknown>;
  cadPropertyRoll: CountyCadPropertyRoll;
  nowIso: string;
}): { leaf: unknown; retired: boolean; servesOk: boolean; origin: string } {
  // The CLI's own branch, reproduced: a record ABSENT from the declared-vintage
  // roll takes `situsForRetiredBake` -- the last-known claim, trimmed, never
  // gated (CTX-RETIRE). Getting this wrong is not academic: the first run of
  // this instrument omitted the branch and reported Caldwell 48055:1 as broken
  // by the change when it is untouched by it. The instrument was wrong, and it
  // said so, which is the point of running it.
  const propId = input.parcelNodeId.split(":")[1] ?? "";
  const rollAbsent =
    input.cadPropertyRoll.consulted && !input.cadPropertyRoll.byPropId.has(propId);
  // The SAME resolver the bake CLI calls, with the SAME inputs -- the claim's
  // raw situs and the declared-vintage roll's own situs. Reimplementing the
  // preference here would let the instrument agree with a bake that had
  // stopped preferring the roll.
  const resolved = resolveConformantSitusAddress({
    claimRaw: input.rawClaimSitus,
    rollRaw: input.rollSitus,
    rollAbsent,
  });
  const payload = buildConformantTier1Payload({
    body: { ...input.claim, parcelNodeId: input.parcelNodeId },
    parcelNodeId: input.parcelNodeId,
    countyFips: input.countyFips,
    countyName: COUNTY_NAMES[input.countyFips] ?? input.countyFips,
    situsAddress: resolved.situs,
    situsAddressUnusable: resolved.unusable,
    situsAddressOrigin: resolved.origin,
    situsAddressSupersededClaim: resolved.supersededClaimValue,
    access: CANONICAL_ACCESS,
    accessNormalizedFrom: null,
    publishRunId: undefined,
    parcelJoin: { table: "txgio_parcel", row: null, gateBlocked: false },
    cadPropertyRoll: input.cadPropertyRoll,
    nowIso: input.nowIso,
  });
  // The write-side controls must accept what we just built, or the AFTER row
  // would never reach the store at all.
  assertRequiredLeafStatesEarned(payload);
  assertSitusAddressAbsenceEarned(payload);
  // RECORD_RETIRED is what hauska-factory verify-walk.mjs grades through the
  // bundled tier1-conformant-lib entrypoint, and refusePayloadAtServe is the
  // gate that must NOT 422 a retired row (CTX-B1 #650). Both run on the real
  // rebuilt payload, not on a copy of the stored one.
  const retired = isEarnedRecordRetirement(payload.recordRetirement);
  let servesOk = true;
  try {
    refusePayloadAtServe(JSON.parse(JSON.stringify(payload)));
  } catch {
    servesOk = false;
  }
  return {
    leaf: payload.baseFacts.situsAddress,
    retired,
    servesOk,
    origin: payload.provenance.situsAddressSource,
  };
}

function selfTest(): number {
  const nowIso = new Date().toISOString();
  const emptyRoll: CountyCadPropertyRoll = {
    byPropId: new Map([["1", { propId: "1", taxYear: 2026, sourceVintage: "x" } as never]]),
    declaredTaxYear: 2026,
    consulted: true,
  };
  const cases: Array<{ name: string; leaf: unknown; mustBeDefective: boolean }> = [
    { name: "bare null", leaf: null, mustBeDefective: true },
    { name: "street-less state+zip", leaf: ", TX 78756", mustBeDefective: true },
    { name: "punctuation only", leaf: ", ,", mustBeDefective: true },
    { name: "real address", leaf: "4709 SHOALWOOD AVE", mustBeDefective: false },
    {
      name: "well-formed earned absence",
      leaf: {
        status: "absent",
        verdict: "absent-verified",
        authority: "a",
        scopeSearched: "b",
        asOf: nowIso,
        basis: "c",
      },
      mustBeDefective: false,
    },
    {
      name: "HALF-BUILT absence (the grader MUST reject this)",
      leaf: { status: "absent", verdict: "absent-verified" },
      mustBeDefective: true,
    },
    {
      name: "street-less shape NEITHER factory regex matches",
      leaf: ", WACO, TX 76705",
      // S1 does not catch it and BP-CONTENT-01 grades a non-empty string a
      // value, so the FACTORY graders both pass it. This case exists to record
      // that the factory graders alone are not sufficient -- it is the reason
      // the write-side predicate had to be meaning-shaped rather than a copy
      // of the two regexes.
      mustBeDefective: false,
    },
  ];
  let failures = 0;
  for (const c of cases) {
    const g = grade(c.leaf);
    const got = isDefective(g);
    const ok = got === c.mustBeDefective;
    if (!ok) failures += 1;
    console.log(
      `[self-test] ${ok ? "OK  " : "FAIL"} ${c.name}: defective=${got} expected=${c.mustBeDefective} ` +
        `content=${g.content.state}/${g.content.ok} sentinel=${g.sentinel}`,
    );
  }
  // And the predicate this change adds DOES catch the case the factory graders miss.
  const missed = classifyRawSitusAddress(", WACO, TX 76705");
  const caught = missed.kind === "unusable";
  if (!caught) failures += 1;
  console.log(
    `[self-test] ${caught ? "OK  " : "FAIL"} classifyRawSitusAddress catches the shape both ` +
      `factory graders miss: kind=${missed.kind}`,
  );
  // Non-vacuous: an unusable leaf must NOT be built without the discriminator.
  void emptyRoll;
  console.log(`[self-test] failures=${failures}`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  if (process.argv.includes("--self-test")) process.exit(selfTest());

  const url = process.env.DATABASE_URL ?? process.env.DEPLOYMENT_DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: true }, max: 2 });
  await pool.query("SET default_transaction_read_only=on");
  await pool.query("SET statement_timeout='120s'");

  // Named, real parcels. The street-less ones are the dispatch's own worked
  // example plus one measured member of each other street-less shape; the
  // control set is a real-street parcel in each affected county.
  // RECOVERABLE: served street-less today, and the county's DECLARED-vintage
  // cad_property row carries a real street. These must serve THAT STREET after
  // the change, never an absence -- converting them would be exactly what
  // ruling A1 forbids. 139,283 cells across the six counties are in this class
  // (Travis 139,256 street-less + Hays 27 bare-null), measured 2026-09-10.
  const recoverable: string[] = [
    "48453:224793", // ", TX 78756"  -> "4709 SHOALWOOD AVE" at declared 2026
    "48453:1000059", // ", TX"        -> a real street at declared 2026
    "48453:302677", // ", TX 78653"
  ];
  // GENUINELY ABSENT: street-less or null served, and the declared roll has no
  // usable street either (or no row at all). The absence machinery is right for
  // these. 31,552 cells.
  const streetLess: string[] = [
    "48309:111788", // ", WACO, TX 76705"        McLennan, declared 2025, roll agrees
    "48021:53205", // ", CEDAR CREEK, TX 78612"  Bastrop, declared 2025, roll agrees
    "48021:10811", // ", , TX"                   Bastrop, matches S1 empty-commas
    "48055:101047", // bare null, Caldwell, roll also carries none
    "48021:100800", // bare null, Bastrop,  roll also carries none
  ];
  const controls: string[] = [
    "48021:34137", // the Bastrop gold parcel
    "48453:305802", // "2610, 2612 S 1 ST" -- a RANGE address whose first comma
    //                   segment is a bare house number. A stricter predicate
    //                   would refuse it; this one must not.
    "48309:103600", // McLennan real street: "2072 WASHINGTON LN , WACO, TX 76708"
  ];
  const retiredControl = "48055:1"; // CTX-B1 regression control

  // VERIFY THE INSTRUMENT BY VIOLATING IT. `--violate` swaps the two sets, so
  // the street-less worked example is graded against the "untouched" rule and
  // must FAIL. A run that passes under --violate is a broken instrument, not a
  // clean codebase; the close records both exit codes.
  if (process.argv.includes("--violate")) {
    const swap = streetLess.splice(0, streetLess.length);
    streetLess.push(...controls.splice(0, controls.length));
    controls.push(...swap);
    // and the recoverable set is asserted to be absences, which it must not be
    streetLess.push(...recoverable);
    console.log("[violate] expectation sets swapped; this run MUST exit 1");
  }

  const wanted = [...recoverable, ...streetLess, ...controls, retiredControl];
  const { rows } = await pool.query<{ place_key: string; payload_json: Record<string, unknown> }>(
    `SELECT place_key, payload_json FROM place_layer_snapshots
      WHERE adapter_key = $1 AND place_key = ANY($2::text[])`,
    [ADAPTER_KEY, wanted.map((p) => `node:${p}`)],
  );
  const stored = new Map(rows.map((r) => [r.place_key.replace(/^node:/, ""), r.payload_json]));

  const nowIso = new Date().toISOString();
  const gradeStored = process.argv.includes("--grade-stored");
  if (gradeStored) {
    console.log(
      "[grade-stored] evaluating the rows AS SERVED TODAY against the new contract; " +
        "this is the BEFORE run and it MUST exit 1",
    );
  }
  const verdicts: Verdict[] = [];
  let failures = 0;
  /** How many street-less rows the FACTORY's own two graders let through. */
  let factoryMissed = 0;

  for (const parcelNodeId of wanted) {
    const payload = stored.get(parcelNodeId);
    if (!payload) {
      console.log(`[skip] ${parcelNodeId}: no stored tier-1 snapshot`);
      continue;
    }
    const [countyFips, propId] = parcelNodeId.split(":") as [string, string];
    const baseFacts = (payload.baseFacts ?? {}) as Record<string, unknown>;
    const beforeLeaf = baseFacts.situsAddress ?? null;

    // The claim's own raw situsAddress, recovered from the stored row itself
    // rather than from cad_property. That matters: the bake reads the CLAIM on
    // the atom body (hauska_mcp), not cad_property, and the two are not the
    // same field -- taking cad_property here would hand the AFTER build a
    // value the BEFORE build never saw, which would make this instrument
    // measure the wrong difference.
    //   stored string  -> the claim carried exactly that (pure passthrough:
    //                     nodeFacetTier1Assemble.ts is `str(input.situsAddress)`)
    //   stored null    -> the claim carried nothing. CTX-SITUS-SKIP is already
    //                     live, so a refused claim would be an absence object,
    //                     not a null.
    //   stored absence -> the raw is quoted verbatim in its own basis.
    let rawClaimSitus: string | null = null;
    if (typeof beforeLeaf === "string") {
      rawClaimSitus = beforeLeaf;
    } else if (isEarnedLeafAbsence(beforeLeaf)) {
      const m = /\((\"(?:[^\"\\]|\\.)*\")\)/.exec(String(beforeLeaf.basis));
      if (m) {
        try {
          rawClaimSitus = JSON.parse(m[1]!) as string;
        } catch {
          rawClaimSitus = null;
        }
      }
    }

    const cad = await pool.query<{
      prop_id: string;
      tax_year: number;
      source_vintage: string;
      market_value: string | null;
      assessed_value: string | null;
      land_value: string | null;
      improvement_value: string | null;
      living_area_sqft: string | null;
      year_built: string | null;
      legal_description: string | null;
      exemption_codes: string[] | null;
      situs_city: string | null;
      situs_zip: string | null;
      situs_address: string | null;
    }>(
      `SELECT prop_id, tax_year, source_vintage, market_value, assessed_value, land_value,
              improvement_value, living_area_sqft, year_built, legal_description,
              exemption_codes, situs_city, situs_zip, situs_address
         FROM cad_property WHERE county_fips=$1 AND prop_id=$2
        ORDER BY tax_year DESC`,
      [countyFips, propId],
    );
    // The bake's own retirement read: presence at the county's DECLARED CAD
    // vintage, resolved from the authoritative declaration table.
    //
    // The first run of this instrument took it from the stored payload's
    // `provenance.parcelVintage` instead, which is the TxGIO PARCEL JOIN's
    // vintage and a different field entirely. On Caldwell that reads 2025
    // while the declared CAD vintage is 2026, so 48055:1 -- an account on the
    // 2025 roll and absent from 2026 -- came back on-roll and the retired
    // control failed. Reading a proxy for the authoritative record, exactly
    // the shape ENFORCEMENT.md names.
    const declared = tryResolveDeclaredCadVintage(countyFips);
    const declaredTaxYear = Number(declared?.taxYear ?? cad.rows[0]?.tax_year ?? 0);
    const declaredRow = cad.rows.find((r) => r.tax_year === declaredTaxYear);
    const byPropId = new Map<string, never>();
    if (declaredRow) {
      byPropId.set(propId, {
        propId,
        taxYear: declaredRow.tax_year,
        sourceVintage: declaredRow.source_vintage,
        marketValue: declaredRow.market_value == null ? null : Number(declaredRow.market_value),
        assessedValue:
          declaredRow.assessed_value == null ? null : Number(declaredRow.assessed_value),
        landValue: declaredRow.land_value == null ? null : Number(declaredRow.land_value),
        improvementValue:
          declaredRow.improvement_value == null ? null : Number(declaredRow.improvement_value),
        livingAreaSqft:
          declaredRow.living_area_sqft == null ? null : Number(declaredRow.living_area_sqft),
        yearBuilt: declaredRow.year_built == null ? null : Number(declaredRow.year_built),
        legalDescription: declaredRow.legal_description,
        exemptionCodes: declaredRow.exemption_codes,
        situsAddress: declaredRow.situs_address,
      } as never);
    }
    const cadPropertyRoll: CountyCadPropertyRoll = {
      byPropId,
      declaredTaxYear: Number.isFinite(declaredTaxYear) ? declaredTaxYear : null,
      consulted: true,
    };

    const claim: Record<string, unknown> = {
      sourceIdentifiers: { prop_id: propId, county_fips: countyFips },
      situsAddress: rawClaimSitus,
      situsCity: declaredRow?.situs_city ?? null,
      situsZip: declaredRow?.situs_zip ?? null,
      taxYear: declaredTaxYear,
    };

    const rollSitus = declaredRow?.situs_address ?? null;
    const built = afterLeaf({
      parcelNodeId,
      countyFips,
      rawClaimSitus,
      rollSitus,
      claim,
      cadPropertyRoll,
      nowIso,
    });
    // `--grade-stored` puts the row AS SERVED TODAY in the "after" position, so
    // the new contract is evaluated against the pre-change bake's own output.
    // It is the BEFORE run, and it must exit 1: that is what "observe it
    // failing before" means with an exit code rather than a narrative.
    const after = gradeStored ? beforeLeaf : built.leaf;
    const retired = gradeStored ? isEarnedRecordRetirement(payload.recordRetirement) : built.retired;
    const servesOk = gradeStored ? true : built.servesOk;
    const origin = gradeStored
      ? ((payload.provenance as Record<string, unknown> | undefined)?.situsAddressSource as
          | string
          | undefined) ?? "(absent on the stored row)"
      : built.origin;

    const before = grade(beforeLeaf);
    const afterG = grade(after);
    const expectation: Verdict["expectation"] = recoverable.includes(parcelNodeId)
      ? "recovered-from-declared-roll"
      : streetLess.includes(parcelNodeId)
        ? "defective-before-clean-after"
        : "untouched";

    let pass: boolean;
    let why: string;
    if (expectation === "recovered-from-declared-roll") {
      // THE REOPENED CARD'S CORE ASSERTION. Before: a street-less string.
      // After: the declared roll's real street, as a plain string value, from
      // source "declared-roll". An earned absence here is a FAILURE -- it
      // would mean a real address was converted into "verified absent".
      const beforeStreetLess =
        beforeLeaf === null ||
        (typeof beforeLeaf === "string" && !situsCarriesStreetComponent(beforeLeaf));
      const afterIsRealStreet =
        typeof after === "string" && situsCarriesStreetComponent(after);
      const notAnAbsence = !isEarnedLeafAbsence(after);
      pass = beforeStreetLess && afterIsRealStreet && notAnAbsence && origin === "declared-roll";
      why =
        `before street-less=${beforeStreetLess}; after real street=${afterIsRealStreet} ` +
        `(${JSON.stringify(after)}); NOT an absence=${notAnAbsence}; source=${origin}; ` +
        `declared-roll situs=${JSON.stringify(rollSitus)}`;
    } else if (expectation === "defective-before-clean-after") {
      // THE PASS CONDITION IS THE MEANING, NOT THE FACTORY'S GRADE. Requiring
      // "the factory graders called this defective before" would tune this
      // instrument to the factory's blind spots: BP-CONTENT-01 grades any
      // non-empty string a value, and S1's two regexes miss ", TX",
      // ", WACO, TX 76705" and ", CEDAR CREEK, TX 78612". Those rows are
      // exactly why this card exists, and an instrument that could not fail on
      // them would certify nothing. So: the BEFORE leaf must be street-less by
      // the rule under test (a bare null, or a string with no street), the
      // AFTER leaf must be a well-formed earned absence, and what the factory
      // graders said is REPORTED beside it as data.
      const beforeStreetLess =
        beforeLeaf === null ||
        (typeof beforeLeaf === "string" && !situsCarriesStreetComponent(beforeLeaf));
      const nowClean = !isDefective(afterG) && isEarnedLeafAbsence(after);
      pass = beforeStreetLess && nowClean;
      why =
        `before street-less=${beforeStreetLess}; after earned absence=${isEarnedLeafAbsence(after)}; ` +
        `FACTORY GRADE of the row served today: content=${before.content.state}/` +
        `${before.content.ok ? "ok" : "REJECT"} sentinel=${before.sentinel} ` +
        `-> factory caught it=${isDefective(before)}`;
      if (!isDefective(before)) factoryMissed += 1;
    } else if (parcelNodeId === retiredControl) {
      // CTX-B1 / CTX-RETIRE: 48055:1 must keep serving its last-known situs
      // AND its retirement. Never converted to an absence by this change.
      const stillString = typeof after === "string";
      const same = after === beforeLeaf;
      pass = stillString && same && retired && servesOk;
      why =
        `retired control: leaf still a string=${stillString}, byte-identical=${same}, ` +
        `isEarnedRecordRetirement=${retired} (this is what verify-walk grades ` +
        `RECORD_RETIRED on), refusePayloadAtServe does NOT refuse=${servesOk}`;
    } else {
      const same = after === beforeLeaf;
      pass = same && typeof after === "string" && servesOk;
      why = `real-street control: byte-identical=${same}, serve guard passes=${servesOk}`;
    }

    if (!pass) failures += 1;
    verdicts.push({
      parcelNodeId,
      rawClaimSitus,
      before: { leaf: beforeLeaf, ...before },
      after: { leaf: after, ...afterG },
      expectation,
      pass,
      why,
    });
  }

  for (const v of verdicts) {
    console.log(
      `${v.pass ? "PASS" : "FAIL"} ${v.parcelNodeId} [${v.expectation}] raw=${JSON.stringify(
        v.rawClaimSitus,
      )}\n      before=${JSON.stringify(
        typeof v.before.leaf === "string" ? v.before.leaf : summarise(v.before.leaf),
      )}\n      after =${JSON.stringify(
        typeof v.after.leaf === "string" ? v.after.leaf : summarise(v.after.leaf),
      )}\n      ${v.why}`,
    );
  }
  console.log(
    JSON.stringify({
      checked: verdicts.length,
      failures,
      recoverableChecked: recoverable.length,
      streetLessChecked: streetLess.length,
      mode: gradeStored ? "grade-stored (BEFORE)" : "rebuilt (AFTER)",
      factoryGradersMissed: factoryMissed,
      countingRule:
        "factoryGradersMissed = named street-less parcels that BP-CONTENT-01 and S1 " +
        "BOTH grade clean today, i.e. rows the walk would pass while serving a " +
        "street-less string. Denominator is streetLessChecked.",
    }),
  );
  await pool.end();
  if (failures > 0) process.exit(1);
}

function summarise(leaf: unknown): unknown {
  const rec = asRecord(leaf);
  if (!rec) return leaf;
  return { verdict: rec.verdict, basis: rec.basis };
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exit(1);
});
