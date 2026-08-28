import { describe, expect, it } from "vitest";
import {
  composeSmartSiteStub,
  railStateFromRead,
  SMART_SITE_STUB_RAILS,
} from "./smartSiteStub";

const ATOM_MISS = {
  attempted: true,
  state: "refused" as const,
  code: "atom-miss",
  kind: "flood" as const,
};

describe("railStateFromRead", () => {
  it("returns unread only when the read was not attempted", () => {
    expect(railStateFromRead({ attempted: false })).toBe("unread");
  });

  it("maps atom-miss to unknown, never absent-verified", () => {
    expect(railStateFromRead(ATOM_MISS)).toBe("unknown");
    expect(railStateFromRead(ATOM_MISS)).not.toBe("absent-verified");
  });

  it("maps pipeline present-outside to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "present",
        kind: "pipeline",
        presentOutside: true,
      }),
    ).toBe("absent-verified");
  });

  it("maps :sd:outside to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "absent",
        kind: "sd",
        entityId: "48021:34137:sd:outside",
      }),
    ).toBe("absent-verified");
  });

  it("does not promote flood typed-absence to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "absent",
        kind: "flood",
      }),
    ).toBe("unknown");
  });

  it("maps a non-miss refusal to refused", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "refused",
        code: "atoms-store-not-configured",
      }),
    ).toBe("refused");
  });
});

describe("composeSmartSiteStub", () => {
  it("emits five-state rails only, with drainage unread when never fetched", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:34137",
      facets: {
        situsAddress: "908 PINE, BASTROP, TX 78602",
        zoning: { district: "SF-1" },
        baseFacts: { landUse: { landUseCode: "A1" } },
      },
      flood: {
        attempted: true,
        state: "present",
        kind: "flood",
      },
      envelopeBriefRefusal: { state: "refused" },
    });
    expect(Object.keys(stub).sort()).toEqual(
      [
        "drainage",
        "envelope",
        "flood",
        "label",
        "landUse",
        "parcelNodeId",
        "situs",
        "url",
        "zoning",
      ].sort(),
    );
    for (const rail of SMART_SITE_STUB_RAILS) {
      expect(["present", "absent-verified", "unknown", "refused", "unread"]).toContain(
        stub[rail],
      );
    }
    expect(stub.label).toBe("908 PINE, BASTROP, TX 78602");
    expect(stub.url).toBe("https://smartsite.cloud/p/48021:34137");
    expect(stub.situs).toBe("present");
    expect(stub.zoning).toBe("present");
    expect(stub.landUse).toBe("present");
    expect(stub.flood).toBe("present");
    expect(stub.drainage).toBe("unread");
    expect(stub.envelope).toBe("refused");
  });

  it("A4: flood atom-miss is unknown and drainage unread stay distinct", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:25420",
      facets: { baseFacts: { situsAddress: ", ," } },
      flood: ATOM_MISS,
    });
    expect(stub.situs).toBe("unknown");
    expect(stub.label).toBe("48021:25420");
    expect(stub.flood).toBe("unknown");
    expect(stub.drainage).toBe("unread");
    expect(stub.flood).not.toBe(stub.drainage);
  });

  it("falsifier: unread does not collapse into unknown", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:34137",
      facets: { zoning: { district: "SF-1" } },
      flood: ATOM_MISS,
      drainage: { attempted: false },
    });
    expect(stub.drainage).toBe("unread");
    expect(stub.flood).toBe("unknown");
    if (stub.drainage === stub.flood) {
      throw new Error("unread collapsed into unknown");
    }
  });
});
