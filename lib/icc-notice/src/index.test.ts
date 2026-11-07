import { describe, expect, it } from "vitest";
import {
  ICC_DISCLAIMER,
  ICC_NOTICE,
  hasIccCitation,
  iccNoticeFor,
  iccNoticeHtml,
  iccNoticeText,
  isIccHost,
  isIccSource,
  isIccUrl,
} from "./index";

describe("ICC host and source policy", () => {
  it("matches iccsafe.org and true subdomains only", () => {
    expect(isIccHost("codes.iccsafe.org")).toBe(true);
    expect(isIccHost("iccsafe.org")).toBe(true);
    expect(isIccHost("noticcsafe.org")).toBe(false);
    expect(isIccHost("iccsafe.org.evil.com")).toBe(false);
    expect(isIccUrl("https://codes.iccsafe.org/content/IBC2021")).toBe(true);
    expect(isIccUrl("https://up.codes/viewer/texas/ibc-2021")).toBe(false);
  });
  it("flags ICC rows by host, jurisdiction or source name", () => {
    expect(isIccSource({ sourceUrl: "https://codes.iccsafe.org/x" })).toBe(true);
    expect(isIccSource({ jurisdictionKey: "icc-model-code" })).toBe(true);
    expect(isIccSource({ sourceName: "ICC Digital Codes" })).toBe(true);
    expect(isIccSource({ sourceName: "Municode", sourceUrl: "https://library.municode.com/x" })).toBe(false);
    expect(isIccSource(null)).toBe(false);
  });
});

describe("ICC notice", () => {
  it("carries Exhibit B verbatim", () => {
    expect(ICC_NOTICE.startsWith("This software contains material which is proprietary")).toBe(true);
    expect(ICC_NOTICE.endsWith("Phone 1-888-ICC-SAFE (422-7233).")).toBe(true);
    expect(ICC_DISCLAIMER).toBe("ICC is not responsible for the performance or technical accuracy of this software.");
  });
  it("shows only when an ICC citation is present", () => {
    expect(iccNoticeFor(["https://codes.iccsafe.org/content/IBC2021P1/chapter-10"])).toEqual({
      notice: ICC_NOTICE,
      disclaimer: ICC_DISCLAIMER,
    });
    expect(hasIccCitation([{ codeBook: "IRC", sectionNumber: "R302.1" }])).toBe(true);
    expect(hasIccCitation(["2021 International Building Code 1612.3"])).toBe(true);
    expect(iccNoticeFor(["City of Bastrop Building Block B3 Section 14-02-008 (bastrop_tx-bdc-2026-adopted)"])).toBeNull();
    expect(iccNoticeFor([])).toBeNull();
    expect(iccNoticeFor(undefined)).toBeNull();
    expect(iccNoticeHtml(["https://library.municode.com/tx/bastrop"])).toBe("");
    expect(iccNoticeText(["No citation (R302.1, edition not set)"])).toBeNull();
    expect(iccNoticeHtml(["https://codes.iccsafe.org/x"])).toContain("ICC is not responsible");
    expect(iccNoticeText(["IBC 1612.3"])).toContain(ICC_NOTICE);
  });
});
