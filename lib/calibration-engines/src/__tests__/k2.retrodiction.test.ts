import { describe, expect, it } from "vitest";

import { resolveEditionInEffect } from "../k2/editionResolve.js";
import {
  normalizeAustinVarianceRow,
  parseCsvToRecords,
} from "../k2/normalizeOutcome.js";
import { runRetrodictionCase } from "../k2/retrodiction.js";

const AUSTIN_EDITION_TABLE = {
  schemaVersion: "edition-effective-date-v1",
  jurisdictionTenant: "austin_tx",
  table: [
    {
      editionId: "austin_tx-ibc-2021-adopted",
      codeFamily: "IBC",
      editionYear: 2021,
      effective_from: "2021-09-01",
      effective_to: "2025-07-09",
    },
  ],
};

describe("resolveEditionInEffect", () => {
  it("resolves case date within edition window", () => {
    const edition = resolveEditionInEffect(
      AUSTIN_EDITION_TABLE,
      "2022-06-15T00:00:00.000Z",
      "IBC",
    );
    expect(edition?.editionId).toBe("austin_tx-ibc-2021-adopted");
  });
});

describe("normalizeAustinVarianceRow", () => {
  it("maps BOA row to normalized outcome with local-code scope", () => {
    const edition = resolveEditionInEffect(
      AUSTIN_EDITION_TABLE,
      "2022-01-15T00:00:00.000Z",
      "IBC",
    );
    const row = normalizeAustinVarianceRow(
      {
        Permit_Number: "2013-000078 2013-000078 BA",
        Folderrsn: "10963106",
        Hearing_Date: "2022-01-15",
        Status_Current: "Approved",
        Zoning_District: "SF-3",
        Variance_Reason: "setback",
      },
      edition,
    );
    expect(row?.outcomeKind).toBe("variance");
    expect(row?.scope).toBe("local-code");
    expect(row?.outcomeLabel).toBe("approved-with-variance");
  });
});

describe("runRetrodictionCase", () => {
  it("deposits backtest evidence for local-code scope", () => {
    const edition = resolveEditionInEffect(
      AUSTIN_EDITION_TABLE,
      "2022-01-15T00:00:00.000Z",
      "IBC",
    );
    const outcome = normalizeAustinVarianceRow(
      {
        Permit_Number: "2013-000078",
        Hearing_Date: "2022-01-15",
        Status_Current: "Approved",
        Zoning_District: "SF-3",
        Variance_Reason: "setback",
      },
      edition,
    )!;

    const result = runRetrodictionCase(outcome, [
      { atomId: "5297", sectionNumber: "25-2-974", keywords: ["setback", "residential"] },
    ]);

    expect(result.scope).toBe("local-code");
    expect(result.depositPayload?.payload.calibrationProvenance).toBe("backtest");
    expect(result.depositPayload?.payload.adjudicator.roleAtJudgment).toBe(
      "issuing-authority",
    );
  });

  it("defers pending-icc permit scope", () => {
    const edition = resolveEditionInEffect(
      AUSTIN_EDITION_TABLE,
      "2022-01-15T00:00:00.000Z",
      "IBC",
    );
    const outcome = normalizeAustinVarianceRow(
      {
        Permit_Number: "x",
        Hearing_Date: "2022-01-15",
        Status_Current: "Approved",
      },
      edition,
    )!;
    const pending = { ...outcome, scope: "pending-icc" as const };
    const result = runRetrodictionCase(pending, []);
    expect(result.scope).toBe("pending-icc");
    expect(result.depositPayload).toBeNull();
  });
});

describe("parseCsvToRecords", () => {
  it("parses quoted CSV", () => {
    const csv = "a,b\n\"hello, world\",2\n";
    const rows = parseCsvToRecords(csv);
    expect(rows[0]?.a).toBe("hello, world");
    expect(rows[0]?.b).toBe("2");
  });
});
