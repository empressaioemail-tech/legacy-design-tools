/**
 * Component-level tests for the shared `ResolvedByChip`.
 *
 * Lives next to the component (Task #367, following Task #362's
 * portal-ui vitest harness) so the chip's resolver-fan-out
 * (hydrated user with avatar → image, hydrated user without avatar
 * → initials, un-hydrated user → initials of raw id, system → "·")
 * is exercised against the rendered DOM without the design-tools
 * `BriefingDivergencesPanel` scaffolding around it.
 *
 * The duplicated coverage on
 * `artifacts/design-tools/src/pages/__tests__/BriefingDivergencesPanel.test.tsx`
 * stays valid as integration cover from the consumer side, but a
 * refactor that touches only the shared chip can no longer ship
 * without ever running a portal-ui-scoped test.
 *
 * The chip has no `useQuery`-style hooks and no module-level state
 * to mock — `formatActorLabel` and `resolverInitials` come from
 * pure helpers in `../lib/`. We just mount it directly and pin the
 * documented DOM shape:
 *   - `data-resolver-kind` reflects the requestor kind (or
 *     `"system"` when the requestor is null),
 *   - `data-resolver-avatar-url` is set only when an `avatarUrl` is
 *     supplied — its absence on the initials path is what tells
 *     consumers the avatar is a fallback rather than a real image,
 *   - the `*-resolver-avatar-fallback` testid only appears on the
 *     initials / system branches (never with an `<img>` present).
 */

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResolvedByChip } from "./ResolvedByChip";

describe("ResolvedByChip", () => {
  it("renders the system glyph and 'system' label when the requestor is null", () => {
    // The system / unattributed branch must surface a neutral "·"
    // glyph rather than an initials chip — otherwise a real user
    // named "S" would be visually indistinguishable from a
    // system-recorded resolve.
    render(<ResolvedByChip resolvedByRequestor={null} />);
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(chip).toHaveAttribute("data-resolver-kind", "system");
    // No avatar URL on the system branch — pin the absence so a
    // future change can't quietly start emitting a stale URL.
    expect(chip).not.toHaveAttribute("data-resolver-avatar-url");
    expect(
      within(chip).getByTestId("briefing-divergences-resolver-avatar-fallback"),
    ).toHaveTextContent("·");
    expect(chip).toHaveTextContent("system");
  });

  it("renders an <img> avatar (no initials fallback) when the user has an avatarUrl", () => {
    render(
      <ResolvedByChip
        resolvedByRequestor={{
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
          avatarUrl: "https://example.test/avatars/user-7.png",
        }}
      />,
    );
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(chip).toHaveAttribute("data-resolver-kind", "user");
    // The avatar URL flows through into the data attribute so
    // surface-level tests / consumers can assert what was rendered
    // without having to read into the <img> src directly.
    expect(chip).toHaveAttribute(
      "data-resolver-avatar-url",
      "https://example.test/avatars/user-7.png",
    );
    // <img> path: the alt is intentionally empty (decorative —
    // the display name is right next to it), and the initials
    // fallback testid must NOT be in the tree on the image branch.
    const img = chip.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      "src",
      "https://example.test/avatars/user-7.png",
    );
    expect(
      within(chip).queryByTestId(
        "briefing-divergences-resolver-avatar-fallback",
      ),
    ).not.toBeInTheDocument();
    expect(chip).toHaveTextContent("Alex Architect");
  });

  it("renders the initials fallback (no <img>) when the user has a displayName but no avatarUrl", () => {
    // A hydrated user without an avatar must surface their two
    // initials so the audit-trail row stays scannable. The image
    // branch must stay dormant — no <img> tag, and the data-attr
    // exposes the absence (undefined) so consumers don't have to
    // probe the DOM.
    render(
      <ResolvedByChip
        resolvedByRequestor={{
          kind: "user",
          id: "user-7",
          displayName: "Alex Architect",
        }}
      />,
    );
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(chip).toHaveAttribute("data-resolver-kind", "user");
    expect(chip).not.toHaveAttribute("data-resolver-avatar-url");
    expect(chip.querySelector("img")).toBeNull();
    const fallback = within(chip).getByTestId(
      "briefing-divergences-resolver-avatar-fallback",
    );
    // First + last initials, upper-cased.
    expect(fallback).toHaveTextContent("AA");
    expect(chip).toHaveTextContent("Alex Architect");
  });

  it("falls back to the raw id (and its initial) when the user is un-hydrated", () => {
    // Un-hydrated user — the API didn't have a friendly displayName
    // to attach. The label must fall back to the raw id (matching
    // `formatActorLabel`'s posture) so attribution can never blank
    // out, and the avatar slot must show whatever initial we can
    // pull from the id rather than a "?" placeholder.
    render(
      <ResolvedByChip
        resolvedByRequestor={{
          kind: "user",
          id: "raw-user-id",
        }}
      />,
    );
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(chip).toHaveAttribute("data-resolver-kind", "user");
    expect(chip).toHaveTextContent("raw-user-id");
    // `resolverInitials("raw-user-id")` → "R" (single token, no
    // whitespace, takes the first letter and upper-cases it).
    expect(
      within(chip).getByTestId("briefing-divergences-resolver-avatar-fallback"),
    ).toHaveTextContent("R");
  });

  it("forwards the requestor kind verbatim for non-user resolvers (e.g. agent)", () => {
    // Agent / system actors are looked up in the friendly-agent
    // label map; the chip itself shouldn't mangle the `kind` value
    // — surface-level filters key off `data-resolver-kind` to
    // bucket rows by requestor type.
    render(
      <ResolvedByChip
        resolvedByRequestor={{
          kind: "agent",
          id: "some-unknown-agent",
        }}
      />,
    );
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(chip).toHaveAttribute("data-resolver-kind", "agent");
    // Unknown agent ids degrade to the raw id (not "system" / "?")
    // so a newly-introduced producer still attributes itself.
    expect(chip).toHaveTextContent("some-unknown-agent");
  });

  it("renders a '?' placeholder initial when the resolved label has no usable letters", () => {
    // Defensive coverage for the `resolverInitials` no-op path —
    // a label that's all whitespace (which can happen if a future
    // back-end ever ships a blank displayName + a blank id) must
    // still leave a visible glyph so the avatar slot doesn't
    // collapse to an empty circle.
    render(
      <ResolvedByChip
        resolvedByRequestor={{
          kind: "user",
          id: "   ",
          displayName: "   ",
        }}
      />,
    );
    const chip = screen.getByTestId("briefing-divergences-resolver-chip");
    expect(
      within(chip).getByTestId("briefing-divergences-resolver-avatar-fallback"),
    ).toHaveTextContent("?");
  });
});
