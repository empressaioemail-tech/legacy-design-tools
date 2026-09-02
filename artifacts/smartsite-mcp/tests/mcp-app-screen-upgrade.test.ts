/**
 * P-101 item 10 — the dead control gets an upgrade path.
 *
 * `mcp-app.ts` renders "Add to screen" on every row unconditionally and has no
 * entitlement input at all, so before this card a free user clicking it met a
 * bare failure. The card allowed two fixes: make the button reflect
 * entitlement, or render the refusal in the panel. The second was taken,
 * because the refusal already arrives on the tool result and the first would
 * mean threading a tier into a served script that has no channel for one — a
 * second place where a tier decision lives, which is the thing the whole card
 * is avoiding.
 *
 * `UPGRADE_TO_OPEN` ("Upgrade to open this parcel") is NOT reused: it names a
 * parcel, and a user who clicked Add to screen is not asking about a parcel.
 * `UPGRADE_TO_SCREEN` is its sibling.
 *
 * Own file rather than an append to mcp-app.test.ts, which open PR #580
 * (P-106) edits.
 */

import { describe, expect, it } from "vitest";

import {
  buildAppHtml,
  declaredLineHtml,
  htmlContractViolations,
  parseToolResult,
  NOT_RETURNED,
  UPGRADE_SCREENS_REASON,
  UPGRADE_TO_OPEN,
  UPGRADE_TO_SCREEN,
  type DeclaredBody,
} from "../src/mcp-app.js";

/**
 * The body `create_screen` hands the panel when the api-server screens gate
 * refuses. Shape produced by `declareUpstreamNonOk` (tool-honesty.ts) from the
 * 402 `requirePeStudioScreens` returns: top-level status is "error", the
 * capability travels in `reason`, and the upstream code in `upstreamStatus`.
 */
const SCREENS_REFUSAL = JSON.stringify({
  error: "upgrade_required",
  message:
    "Studio or Team is required to build a screen. Solo answers one parcel; Studio works a list of them.",
  tier: "free",
  subscriptionTier: null,
  status: "error",
  reason: "studio_screens",
  upstreamStatus: 402,
});

function declaredFor(text: string): DeclaredBody {
  const declared = parseToolResult(text).declared;
  expect(declared).toBeDefined();
  return declared!;
}

describe("P-101 item 10: a screens refusal paints an upgrade prompt, not a failure", () => {
  it("the wire body is read as a declared body carrying the capability name", () => {
    const d = declaredFor(SCREENS_REFUSAL);
    expect(d.status).toBe("error");
    expect(d.reason).toBe(UPGRADE_SCREENS_REASON);
    expect(d.upstreamStatus).toBe(402);
    expect(d.tier).toBe("free");
    expect(d.message).toMatch(/screen/i);
  });

  it("renders the SCREEN upgrade head, never the parcel one, and never the generic failure head", () => {
    const html = declaredLineHtml(declaredFor(SCREENS_REFUSAL));
    expect(html).toContain(`<b>${UPGRADE_TO_SCREEN}</b>`);
    // The two strings this line must not borrow.
    expect(html).not.toContain(UPGRADE_TO_OPEN);
    expect(html).not.toContain(NOT_RETURNED);
    // The reason the user was refused is stated, not implied.
    expect(html).toContain('data-upstream-status="402"');
    expect(html).toContain('<span class="key">tier</span>');
    expect(html).toContain("Studio or Team is required to build a screen");
    expect(html).toContain('data-declared="error"');
    expect(html).toContain(`data-reason="${UPGRADE_SCREENS_REASON}"`);
  });

  it("the two strings are different sentences about different things", () => {
    expect(UPGRADE_TO_SCREEN).not.toBe(UPGRADE_TO_OPEN);
    expect(UPGRADE_TO_OPEN).toMatch(/parcel/i);
    expect(UPGRADE_TO_SCREEN).toMatch(/screen/i);
  });

  it("every OTHER declared body still paints exactly as it did (the branch is narrow)", () => {
    // An upstream error that is NOT a screens refusal keeps the old head.
    const other = declaredLineHtml(
      declaredFor(
        JSON.stringify({
          status: "error",
          reason: "not_found",
          upstreamStatus: 404,
        }),
      ),
    );
    expect(other).toBe(
      `<div class="miss" data-declared="error" data-reason="not_found"><b>${NOT_RETURNED}: not_found</b><span class="mono" data-upstream-status="404">upstream 404</span></div>`,
    );

    // A parcel-level upgrade_required still says "open this parcel".
    const parcel = declaredLineHtml(
      declaredFor(
        JSON.stringify({
          status: "upgrade_required",
          reason: "deep_report",
          tier: "free",
        }),
      ),
    );
    expect(parcel).toContain(`<b>${UPGRADE_TO_OPEN}</b>`);
    expect(parcel).not.toContain(UPGRADE_TO_SCREEN);
  });
});

describe("P-101 item 10: the new copy survives into the SERVED script", () => {
  /**
   * `declaredLineHtml` is embedded into the panel by SOURCE (INLINE_SHARED), so
   * a constant it closes over that is not also emitted as a `var` throws
   * ReferenceError inside the iframe and paints nothing. The unit tests above
   * run against the module and cannot see that. These can.
   */
  it("both new constants are emitted as vars in the served html", () => {
    const html = buildAppHtml();
    expect(html).toContain(`var UPGRADE_TO_SCREEN=${JSON.stringify(UPGRADE_TO_SCREEN)};`);
    expect(html).toContain(
      `var UPGRADE_SCREENS_REASON=${JSON.stringify(UPGRADE_SCREENS_REASON)};`,
    );
    expect(html).toContain("function declaredLineHtml");
  });

  it("the contract check FAILS when either var is dropped (violate to prove it checks)", () => {
    const clean = buildAppHtml();
    expect(htmlContractViolations(clean)).not.toContain("declared_body_unbound");
    expect(htmlContractViolations(clean)).not.toContain("miss_copy_unbound");

    const noReason = clean.replace(
      `var UPGRADE_SCREENS_REASON=${JSON.stringify(UPGRADE_SCREENS_REASON)};`,
      "",
    );
    expect(htmlContractViolations(noReason)).toContain("declared_body_unbound");

    const noCopy = clean.replaceAll(UPGRADE_TO_SCREEN, "");
    expect(htmlContractViolations(noCopy)).toContain("miss_copy_unbound");
  });
});
