import { describe, expect, it } from "vitest";

import { SERVER_ACTOR_IDS } from "@workspace/server-actor-ids";

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
    // Tripwire: if a new server-side actor id is added to
    // `SERVER_ACTOR_IDS` (the source of truth the api-server route
    // files import from) without a matching friendly label here,
    // this test fails so operator-facing attribution stays in
    // lockstep with the back-end. The previous incarnation of this
    // test maintained a hand-coded list that drifted whenever a
    // route added a new producer (e.g. `bim-model-divergence-resolve`
    // shipped without a label and rendered the raw id in the
    // audit trail until someone noticed). Sourcing the expected
    // set from the shared lib closes that gap.
    const missing = SERVER_ACTOR_IDS.filter(
      (id) => !(id in FRIENDLY_AGENT_LABELS),
    );
    expect(missing).toEqual([]);
  });

  it("does not carry stale labels for ids the server no longer emits", () => {
    // Companion check: a label for an id that is not in
    // `SERVER_ACTOR_IDS` is dead code at best and a misleading
    // attribution at worst (an operator could legitimately wonder
    // whose audit-trail row would render with that label). This
    // assertion catches that drift in the other direction.
    const expected = new Set<string>(SERVER_ACTOR_IDS);
    const stale = Object.keys(FRIENDLY_AGENT_LABELS).filter(
      (id) => !expected.has(id),
    );
    expect(stale).toEqual([]);
  });
});
