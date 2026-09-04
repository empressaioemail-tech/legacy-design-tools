/**
 * Route-surface tests for `POST /api/county-ledger/score`.
 *
 * These assert the two things that are true of the ROUTER rather than of the
 * run: that the paths are actually registered, and that the anonymous registry
 * read tells the truth about which rails cannot be scored.
 *
 * WHY THE MOUNT IS WORTH A TEST. Unmatched `/api/*` in this app falls through
 * to the SPA catch-all and answers HTML 200. SS-W7 lost real time to exactly
 * that: Command Center's serving-sweep panel probed a route nobody had
 * mounted, got HTML, and the console correctly refused to read it as JSON — so
 * a missing MOUNT looked like missing DATA. A router that exports cleanly and
 * is never reachable is the same failure wearing a different hat.
 */

import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { countyRailScoreRouter, COUNTY_RAIL_SCORE_LOCK } from "./countyRailScore";

/**
 * SS-W7's recompute lock namespace, as a LITERAL rather than an import.
 * `countyLedger.ts` does not export it on main yet (PR #437 is open), and
 * importing across an in-flight lane's boundary to assert two strings differ
 * would couple this suite to that PR's merge order for no benefit.
 */
const LEDGER_RECOMPUTE_LOCK_NAMESPACE = "county_ledger_recompute";

describe("registered paths", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = (countyRailScoreRouter as any).stack as Array<{
    route?: { path: string; methods: Record<string, boolean> };
  }>;
  const registered = layers
    .filter((l) => l.route)
    .map((l) => ({
      path: l.route!.path,
      methods: Object.keys(l.route!.methods).filter((m) => l.route!.methods[m]),
    }));

  it("registers POST /score", () => {
    expect(registered).toContainEqual({ path: "/score", methods: ["post"] });
  });

  it("registers GET /score/registry", () => {
    expect(registered).toContainEqual({
      path: "/score/registry",
      methods: ["get"],
    });
  });

  it("registers NOTHING at '/' — the ledger router owns that path", () => {
    // This router is mounted at the same /county-ledger prefix as
    // countyLedgerRouter. A handler at '/' here would shadow or be shadowed by
    // the ledger read depending on mount order, which is exactly the kind of
    // ordering dependency that is invisible until it breaks in production.
    expect(registered.map((r) => r.path)).not.toContain("/");
  });
});

describe("advisory lock namespace", () => {
  it("is DISTINCT from the ledger recompute lock", () => {
    // The two legs are independent: scoring writes county_facet_coverage,
    // recompute materializes the snapshot from it. Sharing one namespace would
    // make them block each other for no reason, and a 409 that means "someone
    // is materializing" would be indistinguishable from "someone is scoring".
    expect(COUNTY_RAIL_SCORE_LOCK).toBe("county_rail_score");
    expect(COUNTY_RAIL_SCORE_LOCK).not.toBe(LEDGER_RECOMPUTE_LOCK_NAMESPACE);
  });
});

describe("GET /score/registry", () => {
  function capture(): { res: Response; body: () => unknown } {
    let payload: unknown = null;
    const res = {
      json(v: unknown) {
        payload = v;
        return this;
      },
    } as unknown as Response;
    return { res, body: () => payload };
  }

  it("serves the unscoreable rails as a first-class state, with reason and owner", () => {
    // A rail with no measurement spec must be READABLE as such. Otherwise the
    // only evidence is a grid column full of `not-yet`, which is
    // indistinguishable from a rail whose writer simply has not run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = ((countyRailScoreRouter as any).stack as Array<any>).find(
      (l) => l.route?.path === "/score/registry",
    ).route.stack[0].handle as (req: Request, res: Response) => void;

    const { res, body } = capture();
    handler({} as Request, res);
    const payload = body() as {
      scoreable: string[];
      unspecified: Array<{ railKey: string; unspecifiedReason: string; specOwner: string }>;
      retiredDenominator: Array<{ railKey: string; denominatorKind: string; basis: string }>;
    };

    // P-59 mud scorer (2026-08-23): all 14 rails scoreable; none unspecified.
    const unspecifiedKeys = payload.unspecified.map((u) => u.railKey);
    expect(unspecifiedKeys).toEqual([]);
    for (const railKey of [
      "roads",
      "footprint",
      "easement",
      "rrc-wells",
      "rrc-pipelines",
      "rail-corridor",
      "mud",
    ]) {
      expect(payload.scoreable, railKey).toContain(railKey);
    }
    for (const u of payload.unspecified) {
      expect(u.specOwner.length, u.railKey).toBeGreaterThan(0);
      expect(u.unspecifiedReason.length, u.railKey).toBeGreaterThan(40);
    }
    // And the scoreable set is disjoint from it.
    for (const key of payload.scoreable) {
      expect(unspecifiedKeys).not.toContain(key);
    }
    // Geometry's live rows are retired (S-22): not scoreable, not unspecified.
    const retiredKeys = (payload.retiredDenominator ?? []).map((r) => r.railKey);
    expect(retiredKeys).toContain("geometry");
    expect(payload.scoreable).not.toContain("geometry");
    expect(unspecifiedKeys).not.toContain("geometry");
  });
});
