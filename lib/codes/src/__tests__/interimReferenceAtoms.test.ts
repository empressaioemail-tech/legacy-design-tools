import { describe, expect, it } from "vitest";
import {
  FBC_INTERIM_ATOMS,
  NEC_INTERIM_ATOMS,
  allInterimAtomDefs,
  buildInterimAtomRows,
} from "../interimReferenceAtoms";

describe("interimReferenceAtoms", () => {
  it("FBC atoms carry ungrounded-pending-ICC", () => {
    for (const atom of FBC_INTERIM_ATOMS) {
      expect(atom.groundingFlag).toBe("ungrounded-pending-ICC");
      expect(atom.body).toContain("Interim reference");
    }
  });

  it("NEC atoms carry ungrounded-pending-NFPA", () => {
    for (const atom of NEC_INTERIM_ATOMS) {
      expect(atom.groundingFlag).toBe("ungrounded-pending-NFPA");
      expect(atom.sourceUrl).toContain("nfpa.org");
    }
  });

  it("buildInterimAtomRows stamps platform-internal metadata", () => {
    const rows = buildInterimAtomRows(
      "00000000-0000-0000-0000-000000000001",
      "miami_beach_fl",
      allInterimAtomDefs(),
    );
    expect(rows.length).toBe(FBC_INTERIM_ATOMS.length + NEC_INTERIM_ATOMS.length);
    for (const row of rows) {
      expect(row.jurisdictionKey).toBe("miami_beach_fl");
      expect(row.metadata).toMatchObject({
        accessPolicy: "platform-internal",
        interimDeepLink: true,
      });
      expect(row.contentHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
