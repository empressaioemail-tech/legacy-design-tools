/**
 * Gate 4 / P4 (audit 2026-10-07): blast-radius refusal for repair/patch
 * writers. Same shape as hauska-engine's `writer-blast-radius-guard.mjs`
 * (P-213); see destructiveWriteGuard.ts's header for why this is a
 * separate, cross-repo-parallel implementation rather than an import.
 */
import { describe, expect, it } from "vitest";
import {
  AUTHORISATION_ENV_VAR,
  BlastRadiusRefusal,
  BLAST_RADIUS_EXCEEDED,
  BLAST_RADIUS_OVERRIDE_MALFORMED,
  BLAST_RADIUS_OVERRIDE_MISMATCH,
  BLAST_RADIUS_UNMEASURED,
  evaluateBlastRadius,
  MAX_DESTRUCTIVE_SHARE,
  overrideTokenFor,
  parseBlastRadiusOverride,
} from "./destructiveWriteGuard.js";

const WRITER = "node-facet-patch-cad-roll";
const BURNET = "48053";

describe("evaluateBlastRadius", () => {
  it("declares the program-wide 0.05 threshold", () => {
    expect(MAX_DESTRUCTIVE_SHARE).toBe(0.05);
  });

  it("passes a first-ever run: 0 destructive of N scanned (every field was absent) -- Burnet's first patch is never refused", () => {
    const verdict = evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 0, population: 50000 });
    expect(verdict).toMatchObject({ ok: true, basis: "no-change", share: 0 });
  });

  it("passes a small destructive share under the threshold", () => {
    const verdict = evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 10, population: 50000 });
    expect(verdict.ok).toBe(true);
    expect(verdict.basis).toBe("within-threshold");
    expect(verdict.share).toBeCloseTo(0.0002, 5);
  });

  it("passes a zero-population (no rows at all) run as no-population, never a refusal", () => {
    const verdict = evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 0, population: 0 });
    expect(verdict).toMatchObject({ ok: true, basis: "no-population", share: null });
  });

  it("REFUSES BLAST_RADIUS_EXCEEDED above the threshold, writing nothing, with the exact override token in the message", () => {
    let caught: unknown;
    try {
      evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 95670, population: 100000 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BlastRadiusRefusal);
    const refusal = caught as BlastRadiusRefusal;
    expect(refusal.code).toBe(BLAST_RADIUS_EXCEEDED);
    expect(refusal.message).toContain(`${AUTHORISATION_ENV_VAR}=${WRITER}:${BURNET}:95670/100000`);
  });

  it("REFUSES BLAST_RADIUS_UNMEASURED on a non-integer or negative population/affected", () => {
    expect(() =>
      evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: Number.NaN, population: 100 }),
    ).toThrow(BlastRadiusRefusal);
    try {
      evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: -1, population: 100 });
    } catch (err) {
      expect((err as BlastRadiusRefusal).code).toBe(BLAST_RADIUS_UNMEASURED);
    }
  });

  it("an exact-matching override authorises the measured run", () => {
    const token = overrideTokenFor(WRITER, BURNET, 95670, 100000);
    const raw = token.slice(`${AUTHORISATION_ENV_VAR}=`.length);
    const verdict = evaluateBlastRadius({
      writer: WRITER,
      scopeKey: BURNET,
      affected: 95670,
      population: 100000,
      override: raw,
    });
    expect(verdict).toMatchObject({ ok: true, basis: "override-authorised" });
  });

  it("REFUSES BLAST_RADIUS_OVERRIDE_MISMATCH when the override names a different writer/scope/counts", () => {
    const wrongScope = overrideTokenFor(WRITER, "48021", 95670, 100000).slice(`${AUTHORISATION_ENV_VAR}=`.length);
    expect(() =>
      evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 95670, population: 100000, override: wrongScope }),
    ).toThrow(BlastRadiusRefusal);

    const staleCounts = overrideTokenFor(WRITER, BURNET, 1, 2).slice(`${AUTHORISATION_ENV_VAR}=`.length);
    let caught: unknown;
    try {
      evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 95670, population: 100000, override: staleCounts });
    } catch (err) {
      caught = err;
    }
    expect((caught as BlastRadiusRefusal).code).toBe(BLAST_RADIUS_OVERRIDE_MISMATCH);
  });

  it("REFUSES BLAST_RADIUS_OVERRIDE_MALFORMED on a garbage override string", () => {
    expect(() => parseBlastRadiusOverride("not-a-token")).toThrow(BlastRadiusRefusal);
    try {
      parseBlastRadiusOverride("not-a-token");
    } catch (err) {
      expect((err as BlastRadiusRefusal).code).toBe(BLAST_RADIUS_OVERRIDE_MALFORMED);
    }
  });

  it("FALSIFIER: this guard can fail -- a mutated version comparing affected <= population (not affected/population <= maxShare) wrongly passes 95670/100000", () => {
    function brokenEvaluate(affected: number, population: number) {
      // The exact class of bug this guards against: measuring presence
      // (affected <= population, always true) instead of share.
      return affected <= population;
    }
    expect(brokenEvaluate(95670, 100000)).toBe(true);
    expect(() => evaluateBlastRadius({ writer: WRITER, scopeKey: BURNET, affected: 95670, population: 100000 })).toThrow();
  });
});
