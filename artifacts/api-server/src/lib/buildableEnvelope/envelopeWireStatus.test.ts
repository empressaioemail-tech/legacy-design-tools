/**
 * P-372 (2026-09-19). The four-way class -> status mapping, tested DIRECTLY.
 *
 * Why directly: the mapping is the whole fix at the reporting layer, and no
 * parcel fixture can exercise its `clip-failed` arm any more. The retry draws
 * the parcels that used to land there (Kyle 48209:145880, and the two the
 * six-county sample found), and a parcel whose ring is genuinely unusable is
 * now named at the source (`invalid-input`), so an integration fixture could
 * not make this arm fire. DEV_PROCESS's rule applies — a gating indicator must
 * be proven able to fire — and this is the one place it can be, since
 * `wireStatusForEmptyKind` is a pure function of the derivation's own class.
 *
 * This file imports ONLY the mapping module, so it runs without the
 * setback-corpus resolver and the atom-reconcile chain that
 * `composeBuildableEnvelopeDerivation.test.ts` legitimately needs.
 */

import { describe, expect, it } from "vitest";
import {
  wireStatusForEmptyKind,
  type BuildableEnvelopeWireStatus,
} from "./envelopeWireStatus";

describe("wireStatusForEmptyKind (P-372 class -> stage mapping)", () => {
  it("maps each class to its own status, and never folds clip into validation", () => {
    expect(wireStatusForEmptyKind(false, undefined)).toBe("ok");
    expect(wireStatusForEmptyKind(false, "consumed")).toBe("ok");
    expect(wireStatusForEmptyKind(true, "consumed")).toBe("no-buildable-area");
    expect(wireStatusForEmptyKind(true, "clip-failed")).toBe(
      "geometry-clip-failed",
    );
    expect(wireStatusForEmptyKind(true, "validation-failed")).toBe(
      "geometry-validation-failed",
    );
    expect(wireStatusForEmptyKind(true, "invalid-input")).toBe(
      "geometry-validation-failed",
    );
    // An unclassified empty is a validation decline, never a measurement and
    // never a clip claim.
    expect(wireStatusForEmptyKind(true, undefined)).toBe(
      "geometry-validation-failed",
    );
  });

  it("keeps the two decline stages distinct on the wire (the P-372 defect in one line)", () => {
    expect(wireStatusForEmptyKind(true, "clip-failed")).not.toBe(
      wireStatusForEmptyKind(true, "validation-failed"),
    );
  });

  it("is total over the declared status union — four classes, four statuses", () => {
    const statuses = new Set<BuildableEnvelopeWireStatus>([
      wireStatusForEmptyKind(false, undefined),
      wireStatusForEmptyKind(true, "consumed"),
      wireStatusForEmptyKind(true, "clip-failed"),
      wireStatusForEmptyKind(true, "invalid-input"),
      wireStatusForEmptyKind(true, "validation-failed"),
    ]);
    expect(statuses).toEqual(
      new Set<BuildableEnvelopeWireStatus>([
        "ok",
        "no-buildable-area",
        "geometry-clip-failed",
        "geometry-validation-failed",
      ]),
    );
  });
});
