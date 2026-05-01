/**
 * Tests for the inline citation-pill renderers used by the A–G
 * briefing narrative panel (Task #176).
 *
 * The renderer ships in `briefingCitations.tsx` as four pieces:
 * `BriefingSourceCitationPill`, `BriefingCodeAtomPill`,
 * `BriefingInvalidCitationPill`, and `renderBriefingBody` (which
 * stitches the first two into a sequence of fragments + pills). The
 * imperative `scrollToBriefingSource` helper is also covered to lock
 * down its DOM lookup contract.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import {
  BriefingCodeAtomPill,
  BriefingInvalidCitationPill,
  BriefingSourceCitationPill,
  renderBriefingBody,
  scrollToBriefingSource,
} from "../briefingCitations";

describe("BriefingSourceCitationPill", () => {
  it("calls onJump with the source id when clicked", () => {
    const onJump = vi.fn();
    render(
      <BriefingSourceCitationPill
        sourceId="src-123"
        label="Zoning Code 2024"
        onJump={onJump}
      />,
    );
    const btn = screen.getByTestId("briefing-citation-pill-src-123");
    expect(btn.textContent).toContain("Zoning Code 2024");
    expect(btn.getAttribute("title")).toContain("Zoning Code 2024");
    fireEvent.click(btn);
    expect(onJump).toHaveBeenCalledWith("src-123");
  });
});

describe("BriefingCodeAtomPill", () => {
  it("renders an anchor pointing to the Code Library with the atom id", () => {
    render(<BriefingCodeAtomPill atomId="deadbeef-1111-2222-3333-444455556666" />);
    const link = screen.getByTestId(
      "briefing-code-citation-deadbeef-1111-2222-3333-444455556666",
    );
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toContain(
      "code-library?atom=deadbeef-1111-2222-3333-444455556666",
    );
    // Visible label uses the first 8 chars of the id as a short prefix.
    expect(link.textContent).toMatch(/CODE.deadbeef/);
  });
});

describe("BriefingInvalidCitationPill", () => {
  it("extracts the display label from a stripped briefing-source token", () => {
    render(
      <BriefingInvalidCitationPill token="{{atom|briefing-source|gone-1|Removed Overlay}}" />,
    );
    const pill = screen.getByTestId("briefing-invalid-citation-pill");
    expect(pill.textContent).toContain("Removed Overlay");
    expect(pill.getAttribute("title")).toContain("gone-1");
  });

  it("renders a CODE shorthand label for stripped CODE tokens", () => {
    render(<BriefingInvalidCitationPill token="[[CODE:abcdef0123456789]]" />);
    const pill = screen.getByTestId("briefing-invalid-citation-pill");
    expect(pill.textContent).toMatch(/CODE.abcdef01/);
  });

  it("falls back to the raw token text when the shape is unrecognised", () => {
    render(<BriefingInvalidCitationPill token="{{atom:legacy:thing}}" />);
    const pill = screen.getByTestId("briefing-invalid-citation-pill");
    expect(pill.textContent).toContain("{{atom:legacy:thing}}");
  });
});

describe("renderBriefingBody", () => {
  it("returns the original string in a single-element array when there are no tokens", () => {
    const out = renderBriefingBody(
      "Plain narrative paragraph with no citations.",
      new Set(),
      vi.fn(),
    );
    expect(out).toEqual(["Plain narrative paragraph with no citations."]);
  });

  it("renders a clickable pill for a known briefing-source token interleaved with text", () => {
    const onJump = vi.fn();
    const body =
      "Per {{atom|briefing-source|src-A|Title 24}} the setback is 10 ft.";
    const { container } = render(
      <div>{renderBriefingBody(body, new Set(["src-A"]), onJump)}</div>,
    );
    expect(container.textContent).toContain("Per ");
    expect(container.textContent).toContain(" the setback is 10 ft.");
    const pill = screen.getByTestId("briefing-citation-pill-src-A");
    expect(pill).toBeInTheDocument();
    fireEvent.click(pill);
    expect(onJump).toHaveBeenCalledWith("src-A");
  });

  it("falls back to plain label text when the briefing-source id is not in the known set", () => {
    const body =
      "Per {{atom|briefing-source|src-gone|Old Overlay}} the rule applies.";
    const { container } = render(
      <div>{renderBriefingBody(body, new Set(["src-other"]), vi.fn())}</div>,
    );
    expect(container.textContent).toContain("Old Overlay");
    expect(screen.queryByTestId("briefing-citation-pill-src-gone")).toBeNull();
  });

  it("renders a CODE pill alongside a briefing-source pill in the same body", () => {
    const body =
      "See {{atom|briefing-source|src-1|Setback Map}} and [[CODE:11112222333344445555]] together.";
    render(<div>{renderBriefingBody(body, new Set(["src-1"]), vi.fn())}</div>);
    expect(screen.getByTestId("briefing-citation-pill-src-1")).toBeInTheDocument();
    expect(
      screen.getByTestId("briefing-code-citation-11112222333344445555"),
    ).toBeInTheDocument();
  });

  it("preserves token ordering even when CODE and source tokens interleave", () => {
    const body =
      "[[CODE:aaaaaaaa11112222]] then {{atom|briefing-source|src-mid|Mid Source}} then [[CODE:bbbbbbbb33334444]].";
    const { container } = render(
      <div>{renderBriefingBody(body, new Set(["src-mid"]), vi.fn())}</div>,
    );
    const text = container.textContent ?? "";
    const codeAIdx = text.indexOf("CODE·aaaaaaaa");
    const midIdx = text.indexOf("Mid Source");
    const codeBIdx = text.indexOf("CODE·bbbbbbbb");
    expect(codeAIdx).toBeGreaterThanOrEqual(0);
    expect(midIdx).toBeGreaterThan(codeAIdx);
    expect(codeBIdx).toBeGreaterThan(midIdx);
  });
});

describe("scrollToBriefingSource", () => {
  it("returns false when no matching row exists", () => {
    expect(scrollToBriefingSource("does-not-exist")).toBe(false);
  });

  it("calls scrollIntoView on the matching row and returns true", () => {
    const row = document.createElement("div");
    row.setAttribute("data-testid", "briefing-source-src-99");
    const spy = vi.fn();
    row.scrollIntoView = spy;
    document.body.appendChild(row);
    try {
      expect(scrollToBriefingSource("src-99")).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        behavior: "smooth",
        block: "center",
      });
    } finally {
      row.remove();
    }
  });
});
