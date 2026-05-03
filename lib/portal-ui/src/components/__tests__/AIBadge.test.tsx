/**
 * `AIBadge` — Track 1 / addendum D2.
 *
 * Pins all three rendering branches across all three variants so a
 * future copy / styling change can't silently regress one surface
 * (FindingsTab row / FindingDrillIn / comment-letter draft) while
 * the other two pass review.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AIBadge } from "../AIBadge";

describe("AIBadge", () => {
  describe("row variant — finding row provenance", () => {
    it("renders 'AI generated' when aiGenerated and not yet accepted", () => {
      render(<AIBadge aiGenerated acceptedAt={null} />);
      const badge = screen.getByTestId("ai-badge");
      expect(badge).toHaveAttribute("data-state", "ai-unaccepted");
      expect(badge).toHaveTextContent("AI generated");
      // Crucially: the unaccepted branch must NOT carry a "reviewer
      // confirmed" suffix — that suffix is the surface that tells
      // reviewers their accept landed.
      expect(badge.textContent).not.toMatch(/confirmed/);
    });

    it("renders the reviewer-confirmed line when acceptedAt is set", () => {
      render(
        <AIBadge
          aiGenerated
          acceptedAt="2026-05-03T15:30:00Z"
          acceptedBy={{
            kind: "user",
            id: "u-7",
            displayName: "Alex Reviewer",
          }}
        />,
      );
      const badge = screen.getByTestId("ai-badge");
      expect(badge).toHaveAttribute("data-state", "ai-accepted");
      expect(badge.textContent).toMatch(
        /^AI generated · reviewer confirmed \(Alex Reviewer, .+\)$/,
      );
    });

    it("falls back to the actor id when displayName is empty / missing", () => {
      // `formatActorLabel`'s posture: never blank attribution. The
      // badge must mirror that — surface tests rely on the id being
      // visible when the profile hasn't hydrated yet.
      render(
        <AIBadge
          aiGenerated
          acceptedAt="2026-05-03T15:30:00Z"
          acceptedBy={{ kind: "user", id: "u-7", displayName: "   " }}
        />,
      );
      expect(screen.getByTestId("ai-badge").textContent).toMatch(
        /^AI generated · reviewer confirmed \(u-7, .+\)$/,
      );
    });

    it("renders 'Authored by reviewer (Name)' when aiGenerated is false", () => {
      render(
        <AIBadge
          aiGenerated={false}
          reviewerAuthor={{
            kind: "user",
            id: "u-9",
            displayName: "Sam Author",
          }}
        />,
      );
      const badge = screen.getByTestId("ai-badge");
      expect(badge).toHaveAttribute("data-state", "reviewer-authored");
      expect(badge).toHaveTextContent("Authored by reviewer (Sam Author)");
    });

    it("renders 'unknown' when reviewer-authored without an actor", () => {
      // Defensive — a reviewer-authored row with no actor should
      // never blank out attribution. The fallback string makes the
      // empty case obvious to surface tests.
      render(<AIBadge aiGenerated={false} reviewerAuthor={null} />);
      expect(screen.getByTestId("ai-badge")).toHaveTextContent(
        "Authored by reviewer (unknown)",
      );
    });
  });

  describe("drill-in variant", () => {
    it("uses a slightly larger fontSize than the row variant", () => {
      render(
        <AIBadge
          aiGenerated
          acceptedAt={null}
          variant="drill-in"
        />,
      );
      const badge = screen.getByTestId("ai-badge");
      expect(badge).toHaveAttribute("data-variant", "drill-in");
      expect(badge.style.fontSize).toBe("11px");
    });
  });

  describe("aggregate variant — comment-letter document-level provenance", () => {
    it("renders the document-level copy with finding count and drafting reviewer name", () => {
      render(
        <AIBadge
          aiGenerated
          variant="aggregate"
          findingCount={4}
          draftingReviewerName="Alex Reviewer"
        />,
      );
      expect(screen.getByTestId("ai-badge")).toHaveTextContent(
        "AI generated from 4 open findings · drafting reviewer is Alex Reviewer",
      );
    });

    it("singularizes 'open finding' when count is 1", () => {
      render(
        <AIBadge aiGenerated variant="aggregate" findingCount={1} />,
      );
      expect(screen.getByTestId("ai-badge").textContent).toMatch(
        /^AI generated from 1 open finding$/,
      );
    });

    it("omits the drafting-reviewer suffix when no name is supplied", () => {
      render(
        <AIBadge aiGenerated variant="aggregate" findingCount={0} />,
      );
      expect(screen.getByTestId("ai-badge").textContent).toBe(
        "AI generated from 0 open findings",
      );
    });
  });
});
