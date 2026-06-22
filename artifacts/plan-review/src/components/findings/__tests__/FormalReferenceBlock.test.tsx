import { describe, expect, it } from "vitest";
import {
  buildReferenceByAtomId,
  formalReferenceLabel,
} from "../FormalReferenceBlock";
import type { CodeReferenceEntry } from "@workspace/api-client-react";

const ipmcRef: CodeReferenceEntry = {
  atomId: "icc-model-code/ipmc-2018/302.1",
  sectionIdentifier: "§302.1",
  sectionTitle: "Interior of Structure",
  edition: "2018",
  sourceUrl: "",
  codeTitle: "IPMC",
};

const ibcRef: CodeReferenceEntry = {
  atomId: "icc-model-code/ibc-2018/1005.1",
  sectionIdentifier: "§1005.1",
  sectionTitle: "Minimum Required Egress Width",
  edition: "2018",
  sourceUrl: "",
  codeTitle: "IBC",
};

describe("FormalReferenceBlock helpers", () => {
  it("formats IPMC and IBC reference lines without bodies", () => {
    expect(formalReferenceLabel(ipmcRef)).toBe(
      "IPMC §302.1 — Interior of Structure (2018)",
    );
    expect(formalReferenceLabel(ibcRef)).toBe(
      "IBC §1005.1 — Minimum Required Egress Width (2018)",
    );
  });

  it("indexes references by atom id", () => {
    const map = buildReferenceByAtomId([ipmcRef, ibcRef]);
    expect(map.get(ipmcRef.atomId)?.codeTitle).toBe("IPMC");
    expect(map.get(ibcRef.atomId)?.codeTitle).toBe("IBC");
  });
});
