import { describe, expect, it } from "vitest";

import {
  FRIENDLY_AGENT_LABELS,
  formatActorLabel,
  friendlyAgentLabel,
} from "../actorLabel";

describe("friendlyAgentLabel", () => {
  it("returns the mapped label for a known agent id", () => {
    // The four ids exercised here are emitted by routes the
    // Resolved-divergences panel and the submission timeline both
    // touch, so a regression on any of them would be visible to
    // operators on the audit trail.
    expect(friendlyAgentLabel("snapshot-ingest")).toBe(
      "Site-context automation",
    );
    expect(friendlyAgentLabel("engagement-edit")).toBe("Engagement editor");
    expect(friendlyAgentLabel("bim-model-push")).toBe(
      "Push-to-Revit automation",
    );
    expect(friendlyAgentLabel("briefing-engine")).toBe("Briefing engine");
  });

  it("returns null for an unknown id so callers can pick a fallback", () => {
    // The contract is "null on unknown" — callers (e.g. the
    // SubmissionDetailModal) need to know they should render their
    // own fallback (`kind:id`) rather than render an empty string.
    expect(friendlyAgentLabel("not-a-real-agent")).toBeNull();
    expect(friendlyAgentLabel("")).toBeNull();
  });
});

describe("formatActorLabel", () => {
  it("uses a hydrated user displayName", () => {
    expect(
      formatActorLabel({
        kind: "user",
        id: "user-7",
        displayName: "Alex Architect",
      }),
    ).toBe("Alex Architect");
  });

  it("falls back to the user id when displayName is missing or blank", () => {
    // Two flavours of "no displayName" the API can ship: the field
    // is omitted entirely, or it's present but empty / whitespace.
    // Both should fall through to the raw id rather than collapsing
    // to an anonymous label, mirroring the previous
    // `formatResolvedAttribution` posture.
    expect(formatActorLabel({ kind: "user", id: "user-22" })).toBe("user-22");
    expect(
      formatActorLabel({ kind: "user", id: "user-22", displayName: "" }),
    ).toBe("user-22");
    expect(
      formatActorLabel({ kind: "user", id: "user-22", displayName: "   " }),
    ).toBe("user-22");
  });

  it("renders the friendly label for an agent-kind actor with a known id", () => {
    // The motivating case from Task #270: a Resolved divergence
    // attributed to the snapshot-ingest agent should not surface
    // the raw `snapshot-ingest` id to operators.
    expect(formatActorLabel({ kind: "agent", id: "snapshot-ingest" })).toBe(
      "Site-context automation",
    );
  });

  it("renders the friendly label for a system-kind actor with a known id", () => {
    // Even though the divergence-resolver wire only carries
    // `user` / `agent`, other surfaces (atom history, submission
    // timeline) hand us `system` actors. The label map is
    // intentionally kind-agnostic so they pick up the same polish.
    expect(formatActorLabel({ kind: "system", id: "engagement-edit" })).toBe(
      "Engagement editor",
    );
  });

  it("falls back to the raw id for an unknown agent / system id", () => {
    // A newly-introduced producer that hasn't been added to
    // FRIENDLY_AGENT_LABELS yet should still attribute itself —
    // the fallback degrades to the raw id rather than an empty
    // or anonymous string.
    expect(formatActorLabel({ kind: "agent", id: "future-agent" })).toBe(
      "future-agent",
    );
    expect(formatActorLabel({ kind: "system", id: "future-system" })).toBe(
      "future-system",
    );
  });
});

describe("FRIENDLY_AGENT_LABELS", () => {
  it("covers every server-side stable actor id we emit today", () => {
    // Tripwire: if a new server-side actor id is added without a
    // matching label here, this test fails so the operator-facing
    // attribution stays in lockstep with the back-end. Adding an
    // entry to the map and updating this list keeps the contract
    // mutually documented.
    expect(Object.keys(FRIENDLY_AGENT_LABELS).sort()).toEqual(
      [
        "bim-model-divergence",
        "bim-model-push",
        "bim-model-refresh",
        "briefing-engine",
        "briefing-manual-upload",
        "engagement-edit",
        "snapshot-ingest",
        "submission-ingest",
        "submission-response",
      ].sort(),
    );
  });
});
