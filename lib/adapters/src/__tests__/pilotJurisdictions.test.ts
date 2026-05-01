/**
 * Pilot-jurisdictions list (Task #188).
 *
 * The Site Context tab's empty-pilot banner reads
 * {@link PILOT_JURISDICTIONS} verbatim. The contract this test pins is:
 *
 *   - the visible list cannot drift from the server's `appliesTo` gate
 *     (the registry is the single source of truth);
 *   - every `localKey` present in `ALL_ADAPTERS.jurisdictionGate.local`
 *     has a friendly label here, so a half-wired adapter cannot ship
 *     without surfacing the gap;
 *   - the rendered short labels stay aligned with the city/county
 *     names architects know from the brief (Bastrop TX, Moab UT,
 *     Salmon ID).
 */

import { describe, expect, it } from "vitest";
import {
  PILOT_JURISDICTIONS,
  PILOT_LOCAL_KEYS,
  PILOT_STATE_KEYS,
} from "../pilotJurisdictions";
import { ALL_ADAPTERS } from "../registry";

describe("pilot jurisdictions", () => {
  it("derives PILOT_LOCAL_KEYS from the same registry the server gates on", () => {
    const fromRegistry = Array.from(
      new Set(
        ALL_ADAPTERS.map((a) => a.jurisdictionGate.local).filter(Boolean),
      ),
    ).sort();
    const fromExport = [...PILOT_LOCAL_KEYS].sort();
    expect(fromExport).toEqual(fromRegistry);
  });

  it("derives PILOT_STATE_KEYS from the registry too (state-tier + local-implied)", () => {
    const stateBearing = ALL_ADAPTERS.map(
      (a) => a.jurisdictionGate.state,
    ).filter((s): s is string => Boolean(s));
    for (const s of stateBearing) {
      expect(PILOT_STATE_KEYS).toContain(s);
    }
    // Implied: every local jurisdiction implies its parent state.
    expect(PILOT_STATE_KEYS).toContain("utah");
    expect(PILOT_STATE_KEYS).toContain("idaho");
    expect(PILOT_STATE_KEYS).toContain("texas");
  });

  it("provides a friendly label for every pilot localKey (no half-wired adapters)", () => {
    for (const key of PILOT_LOCAL_KEYS) {
      const entry = PILOT_JURISDICTIONS.find((j) => j.localKey === key);
      expect(entry, `missing pilot label for localKey "${key}"`).toBeDefined();
      expect(entry?.label).toBeTruthy();
      expect(entry?.shortLabel).toBeTruthy();
    }
    // And nothing extra: the visible list is exactly the registry set.
    expect(PILOT_JURISDICTIONS.map((j) => j.localKey).sort()).toEqual(
      [...PILOT_LOCAL_KEYS].sort(),
    );
  });

  it("renders the three DA-PI-4 pilot jurisdictions architects expect", () => {
    const shortLabels = PILOT_JURISDICTIONS.map((j) => j.shortLabel);
    expect(shortLabels).toEqual(
      expect.arrayContaining(["Bastrop, TX", "Moab, UT", "Salmon, ID"]),
    );
    // Stable display order (alphabetical by short label).
    expect(shortLabels).toEqual([...shortLabels].slice().sort());
  });

  it("pairs each local jurisdiction with the right state slug", () => {
    const stateByLocal = Object.fromEntries(
      PILOT_JURISDICTIONS.map((j) => [j.localKey, j.stateKey]),
    );
    expect(stateByLocal["bastrop-tx"]).toBe("texas");
    expect(stateByLocal["grand-county-ut"]).toBe("utah");
    expect(stateByLocal["lemhi-county-id"]).toBe("idaho");
  });
});
