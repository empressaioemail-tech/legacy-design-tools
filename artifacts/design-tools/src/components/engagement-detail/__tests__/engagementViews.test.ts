import { describe, expect, it, beforeEach } from "vitest";
import {
  resolveTabFromSearchParams,
  writeViewStateToUrl,
  type TabId,
} from "../engagementViews";

describe("resolveTabFromSearchParams", () => {
  it("maps legacy ?tab=site-context to property-intel", () => {
    expect(
      resolveTabFromSearchParams(new URLSearchParams("tab=site-context")),
    ).toBe("property-intel");
  });

  it("maps Cockpit ?view=site&segment=property-intel to property-intel", () => {
    expect(
      resolveTabFromSearchParams(
        new URLSearchParams("view=site&segment=property-intel"),
      ),
    ).toBe("property-intel");
  });

  it("maps ?view=review&segment=submissions to submissions", () => {
    expect(
      resolveTabFromSearchParams(
        new URLSearchParams("view=review&segment=submissions"),
      ),
    ).toBe("submissions");
  });

  it("defaults review view to run plan review", () => {
    expect(
      resolveTabFromSearchParams(new URLSearchParams("view=review")),
    ).toBe("run-plan-review");
  });

  it("defaults bare URL to site (Map tab)", () => {
    expect(resolveTabFromSearchParams(new URLSearchParams(""))).toBe("site");
  });
});

describe("writeViewStateToUrl", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/engagements/eng-1");
  });

  function searchAfter(tab: TabId): string {
    writeViewStateToUrl(tab);
    return window.location.search;
  }

  it("writes view=review for run plan review (default review segment omitted)", () => {
    expect(searchAfter("run-plan-review")).toBe("?view=review");
  });

  it("writes view=review&segment=findings for triage inbox", () => {
    expect(searchAfter("findings")).toBe("?view=review&segment=findings");
  });

  it("writes view=review&segment=submissions for submissions", () => {
    expect(searchAfter("submissions")).toBe(
      "?view=review&segment=submissions",
    );
  });

  it("writes view=site&segment=property-intel for property intel", () => {
    expect(searchAfter("property-intel")).toBe(
      "?view=site&segment=property-intel",
    );
  });

  it("clears view params for default site tab", () => {
    window.history.replaceState(
      null,
      "",
      "/engagements/eng-1?view=model&segment=snapshots",
    );
    expect(searchAfter("site")).toBe("");
  });

  it("clears view params for default snapshots tab under model view", () => {
    window.history.replaceState(
      null,
      "",
      "/engagements/eng-1?view=site&segment=property-intel",
    );
    expect(searchAfter("snapshots")).toBe("");
  });
});
