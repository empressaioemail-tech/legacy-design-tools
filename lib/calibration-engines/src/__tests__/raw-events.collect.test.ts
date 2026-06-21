import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { projectRawCalibrationEventsFromRows } from "../raw-events/collectFromRows";
import {
  hasRichLedgerStamp,
  parseRichLedgerPayload,
} from "../raw-events/parseRichLedger";
import type { RawCalibrationJoinRow } from "../raw-events/types";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__");

function loadFixture(name: string): RawCalibrationJoinRow[] {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as RawCalibrationJoinRow[];
}

describe("projectRawCalibrationEventsFromRows", () => {
  it("joins Phase-1 adjudication rows without F3 stamps", () => {
    const { events, phase1OnlyCount } = projectRawCalibrationEventsFromRows(
      loadFixture("phase1-adjudication-rows.json"),
    );

    expect(events).toHaveLength(2);
    expect(phase1OnlyCount).toBe(2);
    expect(events[0]!.kind).toBe("adjudication");
    expect(events[0]!.eventType).toBe("finding.accepted");
    expect(events[0]!.citedAtomIds).toEqual(["code-ibc-1004-1"]);
    expect(events[0]!.jurisdictionTenant).toBe("tx:seguin");
    expect(events[0]!.statedConfidence).toBe(0.82);
    expect(events[0]!.subjectKey).toBe(events[0]!.findingAtomId);
    expect(events[0]!.calibrationFuelProvenance).toBe("unknown");
    expect(events[0]!.modelAttribution).toBeUndefined();
  });

  it("parses F3 rich ledger stamps when present", () => {
    const { events, phase1OnlyCount } = projectRawCalibrationEventsFromRows(
      loadFixture("f3-rich-adjudication-rows.json"),
    );

    expect(events).toHaveLength(1);
    expect(phase1OnlyCount).toBe(0);
    const event = events[0]!;
    expect(event.sourceEventType).toBe("finding.accepted");
    expect(event.adjudicator?.roleAtJudgment).toBe("plan-review-reviewer");
    expect(event.modelAttribution?.modelId).toBe("claude-sonnet-plan-review");
    expect(event.rawCounts).toEqual({ successCount: 1, trialCount: 1 });
    expect(event.citedAtomIds).toHaveLength(2);
  });

  it("includes K2 backtest outcome deposits with provenance backtest", () => {
    const { events } = projectRawCalibrationEventsFromRows(
      loadFixture("k2-backtest-outcome-rows.json"),
    );

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "outcome")).toBe(true);
    expect(events[0]!.calibrationFuelProvenance).toBe("backtest");
    expect(events[0]!.historicalCaseId).toBe("tx:bastrop:permit-2019-0042");
    expect(events[0]!.outcomeKind).toBe("permit-approved-clean");
    expect(events[1]!.calibrationFuelProvenance).toBe("backtest");
    expect(events[1]!.outcomeKind).toBe("permit-approved-with-variance");
  });

  it("filters by jurisdiction tenant and cited atom", () => {
    const allRows = [
      ...loadFixture("phase1-adjudication-rows.json"),
      ...loadFixture("f3-rich-adjudication-rows.json"),
    ];
    const filtered = projectRawCalibrationEventsFromRows(allRows, {
      jurisdictionTenant: "tx:bastrop",
      citedAtomId: "code-ibc-903-2-1",
    });

    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0]!.eventId).toBe("01JF3RICHACCEPT001");
  });

  it("skips rows without code-section citations", () => {
    const phase1 = loadFixture("phase1-adjudication-rows.json");
    const { events } = projectRawCalibrationEventsFromRows([
      {
        ...phase1[0]!,
        citations: [{ kind: "briefing-source", atomId: "brief-1" }],
      },
    ]);
    expect(events).toHaveLength(0);
  });
});

describe("parseRichLedgerPayload", () => {
  it("tolerates absent optional F3 fields", () => {
    const parsed = parseRichLedgerPayload(
      { findingId: "x" },
      "finding.accepted",
    );
    expect(parsed.phase1Only).toBe(true);
    expect(hasRichLedgerStamp({ findingId: "x" })).toBe(false);
  });

  it("defaults live outcome provenance when tag missing", () => {
    const parsed = parseRichLedgerPayload(
      { outcomeKind: "permit-approved" },
      "finding.outcome.recorded",
    );
    expect(parsed.calibrationFuelProvenance).toBe("live");
  });
});
