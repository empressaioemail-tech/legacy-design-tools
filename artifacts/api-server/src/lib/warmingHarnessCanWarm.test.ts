/**
 * SF-30 — Cotality is extinguished. Warming must not gate on cotality:parcels.
 */
import { describe, it, expect } from "vitest";
import { deriveCanWarm } from "./warmingCanWarm";

describe("deriveCanWarm (SF-30)", () => {
  it("does not gate warm on cotality:parcels (Cotality extinguished)", () => {
    const present = new Set<string>();
    expect(deriveCanWarm(present, "coord:30.1100,-97.3200")).toBe(true);
  });

  it("fail-closes on empty placeKey", () => {
    expect(deriveCanWarm(new Set(["cotality:parcels"]), "")).toBe(false);
    expect(deriveCanWarm(new Set(["cotality:parcels"]), "   ")).toBe(false);
  });

  it("unblocks when public-record placeKey is present even if Cotality keys exist leftover", () => {
    const leftover = new Set(["cotality:parcels", "fema:nfhl-flood-zone"]);
    expect(deriveCanWarm(leftover, "coord:30.1100,-97.3200")).toBe(true);
  });
});
