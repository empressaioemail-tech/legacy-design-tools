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

  it("defaults review view to findings", () => {
    expect(
      resolveTabFromSearchParams(new URLSearchParams("view=review")),
    ).toBe("findings");
  });

  it("defaults bare URL to snapshots", () => {
    expect(resolveTabFromSearchParams(new URLSearchParams(""))).toBe(
      "snapshots",
    );
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

  it("writes view=review for findings (default review segment omitted)", () => {
    expect(searchAfter("findings")).toBe("?view=review");
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

  it("clears view params for default snapshots tab", () => {
    window.history.replaceState(
      null,
      "",
      "/engagements/eng-1?view=site&segment=property-intel",
    );
    expect(searchAfter("snapshots")).toBe("");
  });
});
