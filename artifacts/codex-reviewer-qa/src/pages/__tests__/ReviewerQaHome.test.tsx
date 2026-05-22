import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ReviewerQaHome from "../ReviewerQaHome";

/**
 * Smoke test for the Phase 1 scaffold placeholder. Keeps the artifact's
 * `test` script non-empty (so `pnpm -r test` does not fail on a
 * zero-test package) and pins the placeholder's intent.
 */
describe("ReviewerQaHome — Codex Reviewer QA scaffold placeholder", () => {
  it("renders the artifact title and the Phase 1 scaffold badge", () => {
    render(<ReviewerQaHome />);
    expect(screen.getByText("Codex Reviewer QA")).toBeTruthy();
    expect(screen.getByText(/Phase 1 scaffold/i)).toBeTruthy();
  });

  it("lists the Phase 2 reviewer surfaces", () => {
    render(<ReviewerQaHome />);
    for (const id of ["CDX-3", "CDX-4", "CDX-5", "CDX-9"]) {
      expect(screen.getByText(id)).toBeTruthy();
    }
  });
});
