import { describe, expect, it } from "vitest";

import { setbackAtomSuperseded } from "./composeBuildableEnvelopeDerivation";

// QA 2026-09-29, fix register C7: the card quoted an envelope area built on
// setbacks the current table no longer uses, while the PDF withheld it.
const row = (front: number, side: number, rear: number) =>
  ({ district: { front_ft: front, side_ft: side, rear_ft: rear } }) as never;

describe("setbackAtomSuperseded", () => {
  it("flags the 1301 Water St case: atom 25/5/25 against a 30/10/30 table", () => {
    expect(setbackAtomSuperseded({ front: 25, side: 5, rear: 25 }, row(30, 10, 30))).toBe(true);
  });
  it("passes an atom that matches the table", () => {
    expect(setbackAtomSuperseded({ front: 30, side: 10, rear: 30 }, row(30, 10, 30))).toBe(false);
  });
  it("does not flag when either side has no figure", () => {
    expect(setbackAtomSuperseded(null, row(30, 10, 30))).toBe(false);
    expect(setbackAtomSuperseded({ front: 25 }, { district: null } as never)).toBe(false);
  });
});
