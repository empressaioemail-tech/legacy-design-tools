import { describe, it, expect } from "vitest";
import { makeActor, makeFinding } from "../__fixtures__/findings";
import {
  actorLabel,
  citationLabel,
  describeAdjudication,
  formatConfidence,
  sortFindings,
} from "./findings";

describe("formatConfidence", () => {
  it("renders a 0-1 score as a whole percent", () => {
    expect(formatConfidence(0.82)).toBe("82%");
    expect(formatConfidence(1)).toBe("100%");
    expect(formatConfidence(0)).toBe("0%");
  });
});

describe("citationLabel", () => {
  it("uses the atom id for a code-section citation", () => {
    expect(
      citationLabel({ kind: "code-section", atomId: "code-section:x" }),
    ).toBe("code-section:x");
  });

  it("uses the server label for a briefing-source citation", () => {
    expect(
      citationLabel({ kind: "briefing-source", id: "bs-1", label: "Survey PDF" }),
    ).toBe("Survey PDF");
  });
});

describe("sortFindings", () => {
  it("orders blockers before concerns before advisories", () => {
    const sorted = sortFindings([
      makeFinding({ id: "a", severity: "advisory" }),
      makeFinding({ id: "b", severity: "blocker" }),
      makeFinding({ id: "c", severity: "concern" }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks severity ties by most-recent generation time", () => {
    const sorted = sortFindings([
      makeFinding({
        id: "old",
        severity: "concern",
        aiGeneratedAt: "2026-05-01T00:00:00.000Z",
      }),
      makeFinding({
        id: "new",
        severity: "concern",
        aiGeneratedAt: "2026-05-20T00:00:00.000Z",
      }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(["new", "old"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      makeFinding({ id: "a", severity: "advisory" }),
      makeFinding({ id: "b", severity: "blocker" }),
    ];
    const before = input.map((f) => f.id);
    sortFindings(input);
    expect(input.map((f) => f.id)).toEqual(before);
  });
});

describe("actorLabel", () => {
  it("returns the actor display name", () => {
    expect(actorLabel(makeActor({ displayName: "Dana Cole" }))).toBe(
      "Dana Cole",
    );
  });

  it("falls back when there is no actor", () => {
    expect(actorLabel(null)).toBe("a reviewer");
  });
});

describe("describeAdjudication", () => {
  it("returns null for an un-adjudicated finding", () => {
    expect(
      describeAdjudication(makeFinding({ status: "ai-produced" })),
    ).toBeNull();
  });

  it("summarizes an accepted finding with the reviewer and time", () => {
    const line = describeAdjudication(
      makeFinding({
        status: "accepted",
        acceptedBy: makeActor({ displayName: "Dana Cole" }),
        acceptedAt: "2026-05-21T09:00:00.000Z",
      }),
    );
    expect(line).toMatch(/^Accepted by Dana Cole · /);
  });

  it("summarizes a rejected finding", () => {
    const line = describeAdjudication(
      makeFinding({
        status: "rejected",
        reviewerStatusBy: makeActor({ displayName: "Dana Cole" }),
        reviewerStatusChangedAt: "2026-05-21T09:00:00.000Z",
      }),
    );
    expect(line).toMatch(/^Rejected by Dana Cole · /);
  });
});
