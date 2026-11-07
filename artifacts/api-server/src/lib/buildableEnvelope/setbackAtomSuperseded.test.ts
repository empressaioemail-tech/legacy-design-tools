import { describe, expect, it } from "vitest";

import { setbackAtomSuperseded } from "./composeBuildableEnvelopeDerivation";

// QA 2026-09-29, fix register C7: the card quoted an envelope area built on
// setbacks the current table no longer uses, while the PDF withheld it.
const row = (front: number, side: number, rear: number) =>
  ({ district: { front_ft: front, side_ft: side, rear_ft: rear } }) as never;

describe("setbackAtomSuperseded", () => {
  it("flags the 1301 Water St case: an older 25/5/25 atom against a newer 30/10/30 source", () => {
    expect(
      setbackAtomSuperseded(
        { front: 25, side: 5, rear: 25, extractedAt: "2026-08-14T12:00:00Z" },
        row(30, 10, 30),
        "2026-09-25",
      ),
    ).toBe(true);
  });
  it("passes an atom that matches the source", () => {
    expect(
      setbackAtomSuperseded({ front: 30, side: 10, rear: 30, sourceVintage: "2026-08-14" }, row(30, 10, 30), "2026-09-25"),
    ).toBe(false);
  });
  it("keeps a differing atom that is not older than the source (verified and current)", () => {
    expect(
      setbackAtomSuperseded({ front: 25, side: 5, rear: 10, sourceVintage: "2026-09-25" }, row(25, 10, 20), "2026-09-25"),
    ).toBe(false);
  });
  it("keeps a differing atom when either date is missing or unreadable", () => {
    expect(setbackAtomSuperseded({ front: 25, side: 5, rear: 10 }, row(25, 10, 20), "2026-09-25")).toBe(false);
    expect(
      setbackAtomSuperseded({ front: 25, side: 5, rear: 10, sourceVintage: "2026-08-01" }, row(25, 10, 20), "unreadable"),
    ).toBe(false);
  });
  it("does not flag when either side has no figure", () => {
    expect(setbackAtomSuperseded(null, row(30, 10, 30), "2026-09-25")).toBe(false);
    expect(setbackAtomSuperseded({ front: 25, sourceVintage: "2026-08-01" }, { district: null } as never, "2026-09-25")).toBe(false);
  });
});
