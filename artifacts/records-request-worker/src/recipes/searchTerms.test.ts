import { describe, expect, it } from "vitest";
import { resolveSearchTerms, parseParcelKeyPropId } from "./searchTerms.js";

describe("resolveSearchTerms", () => {
  it("reads nested searchTerms from request payload", () => {
    const terms = resolveSearchTerms({
      parcelKey: "apn:48021:34161",
      requestPayload: {
        searchTerms: {
          ownerName: " JANE DOE ",
          situsAddress: "905 Pecan St",
        },
      },
    });
    expect(terms.ownerName).toBe("JANE DOE");
    expect(terms.situsAddress).toBe("905 Pecan St");
    expect(terms.propId).toBe("34161");
  });

  it("falls back to prop id parsed from parcelKey", () => {
    expect(parseParcelKeyPropId("apn:48491:R123456")).toBe("R123456");
    expect(parseParcelKeyPropId("bad")).toBeNull();
  });
});
