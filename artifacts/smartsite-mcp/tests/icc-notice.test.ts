import { describe, expect, it } from "vitest";
import { ICC_DISCLAIMER, ICC_NOTICE } from "@workspace/icc-notice";
import { citationHtml, iccNoticeForCardHtml } from "../src/card/panel-lib.js";
import { precheckDeepHtml, precheckInlineHtml } from "../src/card/precheck-html.js";
import { PRECHECK_FIXTURE } from "../src/plan-review-preview.js";

const withIccCitation = {
  ...PRECHECK_FIXTURE,
  findings: PRECHECK_FIXTURE.findings.map((f, i) =>
    i === 0 ? { ...f, citation: "2021 International Residential Code R302.1" } : f,
  ),
};

describe("ICC notice on the connector card (G-309 Exhibit B)", () => {
  it("the Bastrop fixture cites only the city ordinance: no notice", () => {
    expect(iccNoticeForCardHtml(precheckInlineHtml(PRECHECK_FIXTURE))).toBe("");
    expect(iccNoticeForCardHtml(precheckDeepHtml(PRECHECK_FIXTURE))).toBe("");
  });

  it("a precheck citing an ICC code title shows the notice and disclaimer, inline and deep", () => {
    for (const html of [precheckInlineHtml(withIccCitation), precheckDeepHtml(withIccCitation)]) {
      const n = iccNoticeForCardHtml(html);
      expect(n).toContain("ICC is not responsible for the performance or technical accuracy of this software.");
      expect(n).toContain("Phone 1-888-ICC-SAFE (422-7233).");
    }
  });

  it("a citation control linking to iccsafe.org shows the notice; a city link does not", () => {
    const icc = citationHtml(["https://codes.iccsafe.org/content/IBC2021P1/chapter-16"], false);
    const city = citationHtml(["https://library.municode.com/tx/bastrop"], false);
    const lookalike = citationHtml(["https://noticcsafe.org/x"], false);
    expect(iccNoticeForCardHtml(icc)).toContain("ICC is not responsible");
    expect(iccNoticeForCardHtml(city)).toBe("");
    expect(iccNoticeForCardHtml(lookalike)).toBe("");
  });

  it("carries Exhibit B text exactly once per card", () => {
    const html = citationHtml(["https://codes.iccsafe.org/a", "https://codes.iccsafe.org/b"], false);
    const n = iccNoticeForCardHtml(html);
    expect(n.split("ALL RIGHTS RESERVED").length).toBe(2);
    expect(n).toContain(ICC_DISCLAIMER);
    expect(ICC_NOTICE.length).toBeGreaterThan(900);
  });
});
