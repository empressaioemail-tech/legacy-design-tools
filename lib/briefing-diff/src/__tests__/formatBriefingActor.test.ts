import { describe, expect, it } from "vitest";

import { formatBriefingActor } from "../formatBriefingActor";

describe("formatBriefingActor", () => {
  it("rewrites the mock briefing-engine actor to the friendly label both surfaces share", () => {
    // The contract Task #340 pins: design-tools' EngagementDetail
    // panel and Plan Review's BriefingRecentRunsPanel both render
    // the same friendly "Briefing engine (mock)" label for the
    // `system:briefing-engine` token, so a future change has one
    // place to update.
    expect(formatBriefingActor("system:briefing-engine")).toBe(
      "Briefing engine (mock)",
    );
  });

  it("returns null when the actor token is null, undefined, or empty", () => {
    // Legacy backups can carry `generatedAt` without `generatedBy`
    // (the wire envelope makes the field nullable). Returning null
    // lets the caller short-circuit the meta-line "by …" half
    // instead of rendering "by null" to the auditor.
    expect(formatBriefingActor(null)).toBeNull();
    expect(formatBriefingActor(undefined)).toBeNull();
    expect(formatBriefingActor("")).toBeNull();
  });

  it("returns the raw token unchanged for any other actor", () => {
    // A newly-introduced producer (a real LLM provider, a
    // `system:cron` job, a per-user attribution) that hasn't been
    // mapped here yet should still attribute itself — the fallback
    // degrades to the raw token rather than collapsing to null.
    expect(formatBriefingActor("system:cron")).toBe("system:cron");
    expect(formatBriefingActor("user:42")).toBe("user:42");
    expect(formatBriefingActor("anthropic:claude-3.7")).toBe(
      "anthropic:claude-3.7",
    );
  });
});
