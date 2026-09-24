/**
 * Spec section 3 mapping. One case per table row plus an unmapped set.
 * Also the guard: a broken mapper that guesses `ss_src_direct` for an
 * unmapped set, or writes a retired `source-*` tag, fails these tests.
 */

import { describe, expect, it } from "vitest";
import {
  parseCampaignWire,
  resolveSourceTag,
  serializeCampaign,
} from "./peCampaignSource";

describe("parseCampaignWire", () => {
  it("keeps the four utm keys and drops everything else", () => {
    const parsed = parseCampaignWire(
      "utm_source=youtube&utm_medium=organic&utm_campaign=v2_see_what_your_smart_site_knows&utm_content=desc&fbclid=abc",
    );
    expect(parsed).toEqual({
      utm_source: "youtube",
      utm_medium: "organic",
      utm_campaign: "v2_see_what_your_smart_site_knows",
      utm_content: "desc",
    });
  });

  it("rejects values longer than 64 characters", () => {
    const long = "x".repeat(65);
    expect(parseCampaignWire(`utm_source=${long}`)).toEqual({});
  });
});

describe("resolveSourceTag — spec section 3, one case per row", () => {
  it("Meta ads (facebook + paid) → ss_src_ad", () => {
    const r = resolveSourceTag("utm_source=facebook&utm_medium=paid");
    expect(r).toEqual({
      kind: "resolved",
      tag: "ss_src_ad",
      campaign: { utm_source: "facebook", utm_medium: "paid" },
    });
  });

  it("Meta ads (instagram + paid) → ss_src_ad", () => {
    const r = resolveSourceTag("utm_source=instagram&utm_medium=paid");
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_ad");
  });

  it("Facebook group posts (facebook + group) → ss_src_group", () => {
    const r = resolveSourceTag("utm_source=facebook&utm_medium=group");
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_group");
  });

  it("organic Facebook Page (facebook + organic) → ss_src_page", () => {
    const r = resolveSourceTag("utm_source=facebook&utm_medium=organic");
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_page");
  });

  it("YouTube organic (the live v2 link) → ss_src_page", () => {
    const r = resolveSourceTag(
      "utm_source=youtube&utm_medium=organic&utm_campaign=v2_see_what_your_smart_site_knows",
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_page");
  });

  it("shared smart site (utm_medium=share) → ss_src_share", () => {
    const r = resolveSourceTag("utm_medium=share");
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_share");
  });

  it("no UTMs and no share → ss_src_direct", () => {
    const r = resolveSourceTag(undefined);
    expect(r).toEqual({ kind: "direct", tag: "ss_src_direct", campaign: {} });
    expect(resolveSourceTag("").kind).toBe("direct");
  });

  it("unmapped set is logged as unmapped and gets NO source tag — never a guess", () => {
    const r = resolveSourceTag("utm_source=twitter&utm_medium=cpc");
    expect(r.kind).toBe("unmapped");
    if (r.kind === "unmapped") {
      expect(r.campaign).toEqual({ utm_source: "twitter", utm_medium: "cpc" });
      expect(r).not.toHaveProperty("tag");
    }
  });

  it("facebook + paid wins over facebook + organic when both cannot apply; paid is exact", () => {
    // A paid click with a stray campaign name still maps on source+medium.
    const r = resolveSourceTag(
      "utm_source=facebook&utm_medium=paid&utm_campaign=lookalike",
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.tag).toBe("ss_src_ad");
  });
});

describe("resolveSourceTag — falsifiers against a broken mapper", () => {
  it("does not default an unmapped set to ss_src_direct (the guess this exists to stop)", () => {
    const r = resolveSourceTag("utm_source=unknown");
    expect(r.kind).toBe("unmapped");
    expect(JSON.stringify(r)).not.toContain("ss_src_direct");
  });

  it("never emits a retired source-* or tier-* tag", () => {
    const inputs = [
      "utm_source=facebook&utm_medium=paid",
      "utm_source=affiliate",
      "utm_medium=share",
      undefined,
    ];
    for (const input of inputs) {
      const json = JSON.stringify(resolveSourceTag(input));
      expect(json).not.toMatch(/source-organic|source-affiliate|source-share|source-agent|tier-/);
    }
  });

  it("does not substring-match: agentic-search-test is unmapped, not a share", () => {
    const r = resolveSourceTag("utm_source=agentic-search-test&utm_medium=cpc");
    expect(r.kind).toBe("unmapped");
  });

  it("round-trips the four keys through serialize + parse", () => {
    const original = {
      utm_source: "youtube",
      utm_medium: "organic",
      utm_campaign: "v2",
      utm_content: "desc",
    };
    expect(parseCampaignWire(serializeCampaign(original))).toEqual(original);
  });
});
