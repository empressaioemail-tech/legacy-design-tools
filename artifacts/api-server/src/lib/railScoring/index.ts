/**
 * Rail scoring — the scorer as a standing capability (lane SS-W12, P-47).
 *
 * A rail becomes scoreable by DECLARING how it is measured (`./registry.ts`),
 * not by someone writing another CLI. One engine turns a declaration plus a
 * measurement into a ledger row (`./engine.ts`); one set of measurement kinds
 * is the only code a rail can need (`./measure.ts`); one run is idempotent
 * and reports its own delta (`./run.ts`); one provenance contract keeps every
 * number attached to its denominator (`./provenance.ts`).
 *
 * Triggers: `artifacts/api-server/src/countyRailScoreCli.ts` and
 * `POST /api/county-ledger/score`.
 */

export * from "./provenance";
export * from "./registry";
export * from "./engine";
export * from "./measure";
export * from "./run";
