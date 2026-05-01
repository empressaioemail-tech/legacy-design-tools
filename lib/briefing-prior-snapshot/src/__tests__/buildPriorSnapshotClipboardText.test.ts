/**
 * Standalone coverage for `buildPriorSnapshotClipboardText` (Task #364).
 *
 * Pins the "Copy plain text" payload shape directly so a tweak to
 * section ordering, the "—" placeholder, the `${label}\n\n${body}`
 * block shape, or the `\n\n` block separator surfaces here instead
 * of waiting on the surface integration tests in plan-review and
 * design-tools.
 */

import { describe, expect, it } from "vitest";

import {
  SECTION_ORDER,
  buildPriorSnapshotClipboardText,
  type PriorNarrativeSnapshot,
} from "../BriefingPriorSnapshotHeader";

function snapshot(
  overrides: Partial<
    Pick<
      PriorNarrativeSnapshot,
      | "sectionA"
      | "sectionB"
      | "sectionC"
      | "sectionD"
      | "sectionE"
      | "sectionF"
      | "sectionG"
    >
  > = {},
): PriorNarrativeSnapshot {
  return {
    sectionA: null,
    sectionB: null,
    sectionC: null,
    sectionD: null,
    sectionE: null,
    sectionF: null,
    sectionG: null,
    generatedAt: null,
    generatedBy: null,
    ...overrides,
  };
}

describe("buildPriorSnapshotClipboardText", () => {
  it("emits the seven A–G blocks in canonical order", () => {
    const text = buildPriorSnapshotClipboardText(
      snapshot({
        sectionA: "Body A",
        sectionB: "Body B",
        sectionC: "Body C",
        sectionD: "Body D",
        sectionE: "Body E",
        sectionF: "Body F",
        sectionG: "Body G",
      }),
    );
    expect(text).toBe(
      [
        "A — Executive Summary\n\nBody A",
        "B — Threshold Issues\n\nBody B",
        "C — Regulatory Gates\n\nBody C",
        "D — Site Infrastructure\n\nBody D",
        "E — Buildable Envelope\n\nBody E",
        "F — Neighboring Context\n\nBody F",
        "G — Next-Step Checklist\n\nBody G",
      ].join("\n\n"),
    );
  });

  it("includes every label from SECTION_ORDER", () => {
    // Forward-compat guard: a future section H would slip past the
    // hard-coded payload assertion above unless it's also wired
    // through the helper.
    const text = buildPriorSnapshotClipboardText(
      snapshot({
        sectionA: "Body A",
        sectionB: "Body B",
        sectionC: "Body C",
        sectionD: "Body D",
        sectionE: "Body E",
        sectionF: "Body F",
        sectionG: "Body G",
      }),
    );
    for (const { label } of SECTION_ORDER) {
      expect(text).toContain(label);
    }
  });

  it("renders null, empty, and whitespace-only sections as '—'", () => {
    const text = buildPriorSnapshotClipboardText(
      snapshot({
        sectionA: "Populated A",
        sectionB: null,
        sectionC: "",
        sectionD: "  \n  ",
        sectionE: "Populated E",
        sectionF: null,
        sectionG: null,
      }),
    );
    expect(text).toBe(
      [
        "A — Executive Summary\n\nPopulated A",
        "B — Threshold Issues\n\n—",
        "C — Regulatory Gates\n\n—",
        "D — Site Infrastructure\n\n—",
        "E — Buildable Envelope\n\nPopulated E",
        "F — Neighboring Context\n\n—",
        "G — Next-Step Checklist\n\n—",
      ].join("\n\n"),
    );
  });

  it("renders every section as '—' when the snapshot is fully empty", () => {
    const text = buildPriorSnapshotClipboardText(snapshot());
    expect(text).toBe(
      [
        "A — Executive Summary\n\n—",
        "B — Threshold Issues\n\n—",
        "C — Regulatory Gates\n\n—",
        "D — Site Infrastructure\n\n—",
        "E — Buildable Envelope\n\n—",
        "F — Neighboring Context\n\n—",
        "G — Next-Step Checklist\n\n—",
      ].join("\n\n"),
    );
  });

  it("trims surrounding whitespace from populated bodies", () => {
    const text = buildPriorSnapshotClipboardText(
      snapshot({
        sectionA: "  Body A  \n",
        sectionG: "\n\n  Body G",
      }),
    );
    expect(text).toContain("A — Executive Summary\n\nBody A\n\n");
    expect(text).toContain("G — Next-Step Checklist\n\nBody G");
    // Untrimmed whitespace would shift block separators or reintroduce
    // the leading indent on Body G.
    expect(text).not.toContain("Body A  ");
    expect(text).not.toContain("\n\n\n");
    expect(text).not.toContain("\n\n  Body G");
  });

  it("does not append a trailing newline", () => {
    const text = buildPriorSnapshotClipboardText(
      snapshot({ sectionG: "Tail" }),
    );
    expect(text.endsWith("Tail")).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
  });
});
