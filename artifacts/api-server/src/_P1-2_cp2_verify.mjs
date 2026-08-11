#!/usr/bin/env node
/** CP2: measure live ledger after P1.2 apply, reconcile promotions vs CP1 */
import pg from "pg";

const deployUrl = process.env.DEPLOYMENT_DATABASE_URL;
const atomsUrl = process.env.DATABASE_URL;
if (!deployUrl || !atomsUrl) {
  console.error("Set DEPLOYMENT_DATABASE_URL and DATABASE_URL");
  process.exit(1);
}

const BAND_FIPS = new Set([
  "48095", "48061", "48315", "48459", "48149", "48287", "48265", "48481", "48013", "48137",
]);
const ECTOR = "48135";

const deploy = new pg.Client({ connectionString: deployUrl, ssl: { rejectUnauthorized: false } });
await deploy.connect();

const satisfiedAfter = (
  await deploy.query(
    `SELECT count(*)::int AS n FROM county_facet_coverage WHERE facet='geometry' AND rail_state='satisfied-present'`,
  )
).rows[0].n;

const notYet = (
  await deploy.query(
    `SELECT county_fips, honest_coverage_pct::float AS pct, artifact_path
     FROM county_facet_coverage WHERE facet='geometry' AND rail_state='not-yet' ORDER BY county_fips`,
  )
).rows;

const bandLive = await deploy.query(
  `SELECT county_fips, honest_coverage_pct::float AS pct, rail_state, artifact_path
   FROM county_facet_coverage WHERE facet='geometry' AND county_fips = ANY($1::text[]) ORDER BY county_fips`,
  [Array.from(BAND_FIPS)],
);

// Counties now at 100% with folded > 0 in artifact (promoted by denominator fix)
const allGeometry = await deploy.query(
  `SELECT county_fips, honest_coverage_pct::float AS pct, rail_state, artifact_path
   FROM county_facet_coverage WHERE facet='geometry' AND rail_state='satisfied-present'
     AND artifact_path LIKE '%denom=accounted%foldedExtraFeatures=%'
     AND artifact_path !~ 'foldedExtraFeatures=0'
   ORDER BY county_fips`,
);

const promotedByFold = allGeometry.rows.filter((r) => {
  const m = r.artifact_path?.match(/foldedExtraFeatures=(\d+)/);
  return m && Number(m[1]) > 0 && Number(r.pct) >= 99.99;
});

const bandPromoted = bandLive.rows.filter((r) => r.rail_state === "satisfied-present");
const extraPromoted = promotedByFold.filter((r) => !BAND_FIPS.has(r.county_fips));

const ector = (
  await deploy.query(
    `SELECT county_fips, honest_coverage_pct::float AS pct, rail_state, artifact_path
     FROM county_facet_coverage WHERE facet='geometry' AND county_fips=$1`,
    [ECTOR],
  )
).rows[0];

// Drop check: any county that WAS satisfied before but now not-yet?
// We infer from artifact: old rows lack denom= in artifact_path
const possibleDrops = await deploy.query(
  `SELECT county_fips, honest_coverage_pct::float AS pct, rail_state, artifact_path
   FROM county_facet_coverage WHERE facet='geometry' AND rail_state='not-yet'
     AND honest_coverage_pct::float >= 95`,
);

await deploy.end();

console.log(
  JSON.stringify(
    {
      runAt: new Date().toISOString(),
      geometrySatisfiedAfter: satisfiedAfter,
      geometrySatisfiedBefore: 141,
      delta: satisfiedAfter - 141,
      bandCountiesLive: bandLive.rows,
      bandPromotedCount: bandPromoted.length,
      ector,
      notYetCount: notYet.length,
      notYetRows: notYet,
      promotedByFoldCount: promotedByFold.length,
      extraPromotedBeyondBand: extraPromoted.map((r) => ({
        fips: r.county_fips,
        pct: r.pct,
        folded: r.artifact_path?.match(/foldedExtraFeatures=(\d+)/)?.[1],
      })),
      highCoverageNotYet: possibleDrops.rows,
      dropsDetected: possibleDrops.rows.length,
    },
    null,
    2,
  ),
);
