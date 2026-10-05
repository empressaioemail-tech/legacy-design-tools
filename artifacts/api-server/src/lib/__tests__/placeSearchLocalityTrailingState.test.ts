import { describe, expect, it } from "vitest";

import { parsePlaceSearchLocality } from "../txgioAddressNormalize";

// QA 2026-09-29, fix register C1: a plain address with no comma and no ZIP
// read "BASTROP TX" as the city, so it matched nothing.
describe("parsePlaceSearchLocality: trailing state with no ZIP", () => {
  it("splits the state off the city", () => {
    expect(parsePlaceSearchLocality("1301 Water St Bastrop TX")).toEqual({ city: "BASTROP", state: "TX", zip: null });
  });
  it("keeps a two-word city whole", () => {
    expect(parsePlaceSearchLocality("100 Main St Round Rock TX")).toMatchObject({ city: "ROUND ROCK", state: "TX" });
  });
  it("never takes a street suffix for a state when there is no city", () => {
    const parsed = parsePlaceSearchLocality("1301 Water Ct");
    expect(parsed.state).toBeNull();
  });
  it("leaves the comma and ZIP forms as they were", () => {
    expect(parsePlaceSearchLocality("1301 WATER ST, BASTROP, TX 78602")).toMatchObject({ city: "BASTROP", zip: "78602" });
    expect(parsePlaceSearchLocality("1301 Water St Bastrop")).toMatchObject({ city: "BASTROP", state: null });
  });
});
