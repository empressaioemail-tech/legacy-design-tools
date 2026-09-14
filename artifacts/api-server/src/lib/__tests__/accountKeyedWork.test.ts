import { describe, expect, it } from "vitest";
import { isAccountKeyedNodeId } from "../accountKeyedWork";

/**
 * P-180 (2026-09-13). The bake work-list exclusion that makes P-177's
 * non-durable retirement marker durable. Live fixture: Hays 48209 production
 * has a `txgio_parcel` row for 97658 (a real TxGIO node) and none for the
 * five hollow account-keyed ids P-177 retired.
 */
describe("P-180 isAccountKeyedNodeId (bake work-list exclusion)", () => {
  const haysTxgioPropIds = new Set(["97658", "97651", "97652", "97653", "97657"]);

  it("excludes the hollow account-keyed ids P-177 retired", () => {
    for (const id of ["84639", "84632", "84633", "84634", "84638"]) {
      expect(isAccountKeyedNodeId(id, haysTxgioPropIds)).toBe(true);
    }
  });

  it("keeps every real TxGIO node, including the ones whose bare number also collides with a CAD account", () => {
    for (const id of ["97658", "97651", "97652", "97653", "97657"]) {
      expect(isAccountKeyedNodeId(id, haysTxgioPropIds)).toBe(false);
    }
  });

  it("does not treat a malformed/empty prop id as account-keyed", () => {
    expect(isAccountKeyedNodeId("", haysTxgioPropIds)).toBe(false);
    expect(isAccountKeyedNodeId("   ", haysTxgioPropIds)).toBe(false);
  });

  it("excludes every id when the county publishes no TxGIO prop ids at all", () => {
    expect(isAccountKeyedNodeId("97658", new Set())).toBe(true);
  });
});
