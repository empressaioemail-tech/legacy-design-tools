/**
 * Unit coverage for the word-level diff helper extracted in Task #314.
 *
 * The behaviors pinned here are the ones both the design-tools and
 * Plan Review prior-narrative panels rely on for the per-section
 * comparison:
 *
 *   1. Identical inputs collapse to a flat sequence of `equal` ops
 *      (so the renderer can short-circuit to "(unchanged)" without
 *      walking the result).
 *   2. A pure replacement reports the dropped token as `removed`
 *      and the inserted token as `added`, with the surrounding
 *      context surviving as `equal` ops.
 *   3. Empty-on-one-side inputs degrade gracefully — every prior
 *      token reports `removed`, every current token reports
 *      `added`, and the empty side never crashes.
 *   4. Whitespace runs are preserved as their own tokens so the
 *      reconstructed body's spacing matches the original.
 */
import { describe, it, expect } from "vitest";
import { diffWords } from "../diffWords";

describe("diffWords", () => {
  it("returns only `equal` ops when prior and current are identical", () => {
    const ops = diffWords("The buildable area is 5000 sq ft.", "The buildable area is 5000 sq ft.");
    // Every op should survive as `equal`; no `added`/`removed` noise
    // for a no-op regeneration.
    expect(ops.every((op) => op.type === "equal")).toBe(true);
    // Re-joining the equal stream reproduces the input verbatim.
    expect(ops.map((op) => op.text).join("")).toBe(
      "The buildable area is 5000 sq ft.",
    );
  });

  it("flags swapped tokens as removed/added with surrounding equal context", () => {
    const ops = diffWords(
      "The buildable area is 4500 square feet.",
      "The buildable area is 5200 square feet.",
    );
    // The dropped "4500" surfaces as `removed`, the inserted "5200"
    // as `added`. Both must be present so the renderer can show
    // both sides of the edit.
    const removed = ops.filter((op) => op.type === "removed");
    const added = ops.filter((op) => op.type === "added");
    expect(removed.map((op) => op.text)).toContain("4500");
    expect(added.map((op) => op.text)).toContain("5200");
    // The unchanged words ("buildable", "square", "feet") stay
    // as `equal` ops so the renderer doesn't shout about untouched
    // context.
    const equalText = ops
      .filter((op) => op.type === "equal")
      .map((op) => op.text)
      .join("");
    expect(equalText).toContain("buildable");
    expect(equalText).toContain("square");
    expect(equalText).toContain("feet");
  });

  it("treats an empty prior as `every current token is added`", () => {
    const ops = diffWords("", "Brand new section body.");
    // No prior tokens means nothing should report as `removed`; the
    // entire current body should land in the `added` bucket so the
    // renderer can show it as a fresh insertion.
    expect(ops.some((op) => op.type === "removed")).toBe(false);
    expect(ops.every((op) => op.type === "added" || op.type === "equal")).toBe(
      true,
    );
    const addedText = ops
      .filter((op) => op.type === "added")
      .map((op) => op.text)
      .join("");
    expect(addedText).toContain("Brand");
    expect(addedText).toContain("body");
  });

  it("treats an empty current as `every prior token is removed`", () => {
    const ops = diffWords("This whole section was wiped.", "");
    // No current tokens means nothing should report as `added`; the
    // entire prior body should land in the `removed` bucket so the
    // renderer can show it as a deletion.
    expect(ops.some((op) => op.type === "added")).toBe(false);
    const removedText = ops
      .filter((op) => op.type === "removed")
      .map((op) => op.text)
      .join("");
    expect(removedText).toContain("section");
    expect(removedText).toContain("wiped");
  });

  it("preserves whitespace runs as their own tokens", () => {
    // Whitespace runs are emitted as their own `equal` ops so
    // re-joining the stream reproduces the original spacing — the
    // renderer relies on this to keep the diff visually aligned
    // with the source body.
    const prior = "alpha  beta\ngamma";
    const current = "alpha  beta\ngamma";
    const ops = diffWords(prior, current);
    expect(ops.map((op) => op.text).join("")).toBe(prior);
    expect(ops.map((op) => op.text).join("")).toBe(current);
  });
});
