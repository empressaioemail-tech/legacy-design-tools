/**
 * URL deep-link helper coverage for AIR-2 (Task #310).
 *
 * Mirrors the design-tools `readTabFromUrl` / `writeTabToUrl` test
 * style: stub `window.location` + `window.history.replaceState`,
 * round-trip the helpers, and assert both happy-path values + the
 * allow-list rejecting junk inputs (no `pushState`, no XSS-shaped
 * ids leaking through).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  FINDING_QUERY_PARAM,
  SUBMISSION_QUERY_PARAM,
  SUBMISSION_TAB_QUERY_PARAM,
  isWellFormedFindingId,
  readFindingFromUrl,
  readSubmissionFromUrl,
  readSubmissionTabFromUrl,
  submissionIdFromFindingId,
  writeFindingToUrl,
  writeSubmissionTabToUrl,
  writeSubmissionToUrl,
} from "../findingUrl";

// happy-dom rejects cross-origin replaceState (it must match the
// document origin), so we use the same origin happy-dom uses for
// `window.location` by default and write a relative URL.
function setUrl(search: string): void {
  const next = `/plan-review/engagements/eng-1${search ? (search.startsWith("?") ? search : `?${search}`) : ""}`;
  window.history.replaceState(null, "", next);
}

describe("finding atom-id allow-list", () => {
  it("accepts well-formed finding ids", () => {
    expect(isWellFormedFindingId("finding:sub-1:01H8FOOBAR")).toBe(true);
    expect(isWellFormedFindingId("finding:sub-1:abc.def-123")).toBe(true);
  });
  it("rejects malformed / dangerous ids", () => {
    expect(isWellFormedFindingId("")).toBe(false);
    expect(isWellFormedFindingId("not-a-finding")).toBe(false);
    expect(isWellFormedFindingId("finding:sub-1")).toBe(false);
    expect(isWellFormedFindingId('finding:sub-1:"><script>')).toBe(false);
    expect(isWellFormedFindingId("finding:sub-1:" + "a".repeat(300))).toBe(
      false,
    );
  });
  it("extracts the submission id from a finding id", () => {
    expect(submissionIdFromFindingId("finding:sub-XYZ:01HXX")).toBe("sub-XYZ");
    expect(submissionIdFromFindingId("garbage")).toBeNull();
  });
});

describe("URL deep-link helpers", () => {
  beforeEach(() => {
    setUrl("");
  });

  it("reads and writes the finding param", () => {
    expect(readFindingFromUrl()).toBeNull();
    writeFindingToUrl("finding:sub-1:abc.def-1");
    expect(readFindingFromUrl()).toBe("finding:sub-1:abc.def-1");
    writeFindingToUrl(null);
    expect(readFindingFromUrl()).toBeNull();
  });

  it("rejects malformed ids on write", () => {
    writeFindingToUrl("hax");
    expect(window.location.search).not.toContain(FINDING_QUERY_PARAM);
  });

  it("derives the submission id from a finding deep-link", () => {
    setUrl(`?${FINDING_QUERY_PARAM}=finding:sub-derived:abc123`);
    expect(readSubmissionFromUrl()).toBe("sub-derived");
    expect(readSubmissionTabFromUrl()).toBe("findings");
  });

  it("prefers an explicit submission param when both are set", () => {
    setUrl(
      `?${SUBMISSION_QUERY_PARAM}=sub-explicit&${FINDING_QUERY_PARAM}=finding:sub-derived:abc123`,
    );
    expect(readSubmissionFromUrl()).toBe("sub-explicit");
  });

  it("defaults the tab to note when neither tab nor finding is set", () => {
    setUrl(`?${SUBMISSION_QUERY_PARAM}=sub-1`);
    expect(readSubmissionTabFromUrl()).toBe("note");
  });

  it("writes the tab and clears it when set back to note", () => {
    writeSubmissionTabToUrl("findings");
    expect(window.location.search).toContain(`${SUBMISSION_TAB_QUERY_PARAM}=findings`);
    writeSubmissionTabToUrl("note");
    expect(window.location.search).not.toContain(SUBMISSION_TAB_QUERY_PARAM);
  });

  it("clearing the submission also clears the dependent params", () => {
    writeSubmissionToUrl("sub-1");
    writeSubmissionTabToUrl("findings");
    writeFindingToUrl("finding:sub-1:abc");
    writeSubmissionToUrl(null);
    expect(window.location.search).not.toContain(SUBMISSION_QUERY_PARAM);
    expect(window.location.search).not.toContain(SUBMISSION_TAB_QUERY_PARAM);
    expect(window.location.search).not.toContain(FINDING_QUERY_PARAM);
  });

  it("uses replaceState (not pushState) so back-button history stays clean", () => {
    const replaceSpy = vi.spyOn(window.history, "replaceState");
    const pushSpy = vi.spyOn(window.history, "pushState");
    writeFindingToUrl("finding:sub-1:abc");
    writeSubmissionToUrl("sub-1");
    writeSubmissionTabToUrl("findings");
    expect(replaceSpy).toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    replaceSpy.mockRestore();
    pushSpy.mockRestore();
  });
});
