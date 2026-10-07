/**
 * Burnet (48053) address-ingest county registration (OPS-24 Phase 1,
 * 2026-10-07). This does NOT load any address points (the WDLL/P-287
 * records Burnet address points as still 0 of 35,857) — it only lets
 * `--county=48053` resolve so the load CAN happen in its own stage.
 */
import { describe, expect, it } from "vitest";
import { resolveAddressCounty, ADDRESS_COUNTIES } from "../counties";

describe("resolveAddressCounty — Burnet (48053)", () => {
  it("resolves by FIPS", () => {
    expect(resolveAddressCounty("48053")).toEqual({
      fips: "48053",
      name: "Burnet",
    });
  });

  it("resolves by name, case-insensitively", () => {
    expect(resolveAddressCounty("burnet")).toEqual({
      fips: "48053",
      name: "Burnet",
    });
    expect(resolveAddressCounty("Burnet")).toEqual(ADDRESS_COUNTIES["48053"]);
  });

  it("is present in the registry map directly (not only via statewide fallback)", () => {
    expect(ADDRESS_COUNTIES["48053"]).toBeDefined();
  });
});
