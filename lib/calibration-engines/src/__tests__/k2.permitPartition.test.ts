import { describe, expect, it } from "vitest";

import {
  classifyAustinPermitDomain,
  scopeFromPermitDomain,
} from "../k2/permitPartition.js";
import { resolveLocalEditionInEffect } from "../k2/localEditionResolve.js";

describe("classifyAustinPermitDomain", () => {
  it("classifies electrical permit as I-Code-dependent", () => {
    const domain = classifyAustinPermitDomain({
      "Permit Type": "EP",
      "Permit Type Desc": "Electrical Permit",
      "Work Class": "Wall",
      Description: "Mi Casa Family Dentistry",
    });
    expect(domain).toBe("icode-dependent");
    expect(scopeFromPermitDomain(domain)).toBe("pending-icc");
  });

  it("classifies landscape permit as local-code-evaluable", () => {
    const domain = classifyAustinPermitDomain({
      "Permit Type": "LP",
      "Permit Type Desc": "Landscape Permit",
      Description: "Tree removal and landscape plan",
      "Work Class": "Landscape",
    });
    expect(domain).toBe("local-code-evaluable");
    expect(scopeFromPermitDomain(domain)).toBe("local-code");
  });

  it("defers ambiguous permits to I-Code bucket", () => {
    const domain = classifyAustinPermitDomain({
      "Permit Type": "XX",
      Description: "",
      "Work Class": "",
    });
    expect(domain).toBe("deferred-ambiguous");
  });
});

describe("resolveLocalEditionInEffect", () => {
  const table = {
    schemaVersion: "edition-effective-date-v1",
    jurisdictionTenant: "austin_tx",
    table: [
      {
        editionId: "austin_tx-ibc-2021-adopted",
        codeFamily: "IBC",
        editionYear: 2021,
        effective_from: "2021-09-01",
        effective_to: null,
      },
    ],
  };

  it("resolves LDC edition from municode snapshot window", () => {
    const edition = resolveLocalEditionInEffect(
      table,
      "2022-06-15T00:00:00.000Z",
      "austin_tx",
    );
    expect(edition?.codeFamily).toBe("LDC");
    expect(edition?.editionYear).toBe(2021);
  });
});
