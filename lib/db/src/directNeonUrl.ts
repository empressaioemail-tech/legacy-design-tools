/**
 * Derive a Neon direct (unpooled) connection URL from a configured one
 * (gate 4 / P4, 2026-10-07).
 *
 * `takeCadPropertyWriteLock` (`cadPropertyWriteLock.ts`) refuses a
 * `-pooler` host outright, because `pg_try_advisory_lock` is session-
 * scoped and a Neon `-pooler` host runs PgBouncer in transaction mode,
 * which can return the underlying server connection to the pool between
 * statements -- a session lock taken through one may land on, and later
 * be released on behalf of, a DIFFERENT client, and the client that took
 * it can never reliably release it.
 *
 * Coordinator-verified 2026-10-07 (tested only whether the value contains
 * `-pooler`, without printing either secret): `STAGING_NEONDB_URL` and
 * `PRODUCTION_NEONDB_URL` -- the two env vars `cli.ts` and
 * `published-identifier-backfill-cli.ts` resolve, and the host the p124
 * script's bare `DATABASE_URL` also points at -- are BOTH pooled. As
 * written, the refusal above would make every `cad_property` writer
 * refuse unconditionally, which is safe but blocks Burnet's roll load.
 *
 * So the three `cad_property` writers derive the direct host from
 * whichever URL they were configured with, and open THEIR CONNECTION
 * (the one they write cad_property through, and the one that takes the
 * lock) on the direct host -- never the pooled one they were handed.
 * This is a per-writer, per-run connection (one each for the loader, the
 * identifier backfill, and the one-off p124 repair), well within Neon's
 * direct-connection limit; it is not a change to how any OTHER service
 * connects, and read paths are untouched.
 *
 * SEARCHED FIRST (per the coordinator's instruction) for an existing
 * equivalent before adding this: `legacy-design-tools` has none.
 * `hauska-factory`'s `refusePoolerHost` (`src/db/connect.mjs`) and
 * `neon-branches.mjs` only ever REFUSE a pooled host; neither derives a
 * direct one. `hauska-engine` has at least nine scattered one-line
 * inline copies of this exact derivation
 * (`raw.replace("-pooler.", ".")` / `String(url).replace(/-pooler/g, "")`
 * in `apply-tx-zoning-district-staging-migration.mjs`,
 * `drain-tx-zoning-district-staging.mjs`,
 * `join-zoning-district-to-parcels.mjs`,
 * `migrate-bastrop-road-legacy-synthetic-ids.mjs`,
 * `stage-tx-zoning-district.mjs`, `strip-cad-parcel-roll-owner-fields.mjs`,
 * `stage-discovered.ts`, `benchmark-property-atom-write.mjs`, and two
 * integration tests) -- a different repo this one cannot import from, and
 * itself exactly the kind of uncollected duplication this program keeps
 * finding. None of them is "the" shared helper; this is a new one, in
 * the one package both `@workspace/cad-ingest` call sites already depend
 * on.
 */

/**
 * Neon's convention: the pooled endpoint and the direct endpoint for the
 * SAME branch share one hostname, except the pooled one carries a
 * `-pooler` suffix on the FIRST label only --
 * `ep-xxx-pooler.region.aws.neon.tech` -> `ep-xxx.region.aws.neon.tech`.
 * User, password, port, database and every query param are untouched.
 *
 * An already-direct URL (no `-pooler` on the first label) is returned
 * UNCHANGED -- the exact input string, not a re-serialized equivalent --
 * so this is a safe no-op to call unconditionally on a URL that might
 * already be direct.
 */
export function directNeonUrl(dsn: string): string {
  const url = new URL(dsn);
  const labels = url.hostname.split(".");
  const first = labels[0] ?? "";
  if (!first.endsWith("-pooler")) {
    return dsn;
  }
  labels[0] = first.slice(0, -"-pooler".length);
  url.hostname = labels.join(".");
  return url.toString();
}
