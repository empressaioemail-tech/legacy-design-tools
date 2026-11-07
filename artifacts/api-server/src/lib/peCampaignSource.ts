/**
 * Resolve a first-touch campaign set to one `ss_src_*` tag, or to nothing.
 *
 * Spec: `_inbox/2026-09-24_marketing_build_spec_NICK.md` section 3.
 * Dispatch P-413: an unmapped set is logged and gets NO source tag, never a
 * guess. `ss_src_direct` is written ONLY when the arrival carried no UTMs
 * and no share.
 *
 * THE DEFECT THIS REPLACES. `peGhlContact.ts` wrote a hardcoded
 * `source-organic` tag on every new signup, so a paid-ad click was filed as
 * organic. P-324's staged `feat/utm-source-tag` fixed the hardcode but still
 * wrote the retired `source-*` set. This module reuses that mechanism
 * (sealed OIDC campaign string → one tag) with the spec's `ss_src_*` names.
 *
 * The client does not decide the tag. Cortex is the only mapper.
 */

const CAMPAIGN_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
] as const;

export type CampaignSet = Partial<
  Record<(typeof CAMPAIGN_KEYS)[number], string>
>;

const MAX_VALUE_LENGTH = 64;

export const SOURCE_TAGS = [
  "ss_src_ad",
  "ss_src_group",
  "ss_src_page",
  "ss_src_share",
  "ss_src_direct",
] as const;

export type SourceTag = (typeof SOURCE_TAGS)[number];

export type SourceTagResolution =
  | { kind: "resolved"; tag: SourceTag; campaign: CampaignSet }
  | { kind: "unmapped"; campaign: CampaignSet }
  | { kind: "direct"; tag: "ss_src_direct"; campaign: CampaignSet };

export function parseCampaignWire(serialized: unknown): CampaignSet {
  const out: CampaignSet = {};
  if (typeof serialized !== "string" || !serialized) return out;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(serialized);
  } catch {
    return out;
  }
  for (const key of CAMPAIGN_KEYS) {
    const raw = params.get(key);
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) continue;
    out[key] = trimmed;
  }
  return out;
}

function hasAny(campaign: CampaignSet): boolean {
  return CAMPAIGN_KEYS.some((key) => typeof campaign[key] === "string");
}

function lower(value: string | undefined): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function isOneOf(
  value: string | undefined,
  candidates: readonly string[],
): boolean {
  const v = lower(value);
  if (!v) return false;
  return candidates.some((c) => c === v);
}

/**
 * Spec section 3, first match wins. Exact values, not substrings — a
 * campaign named `agentic-search-test` is not a share or an ad.
 */
const SOURCE_TAG_RULES: readonly {
  tag: Exclude<SourceTag, "ss_src_direct">;
  matches: (c: CampaignSet) => boolean;
}[] = [
  {
    tag: "ss_src_share",
    matches: (c) => isOneOf(c.utm_medium, ["share"]),
  },
  {
    tag: "ss_src_ad",
    matches: (c) =>
      isOneOf(c.utm_source, ["facebook", "instagram"]) &&
      isOneOf(c.utm_medium, ["paid"]),
  },
  {
    tag: "ss_src_group",
    matches: (c) =>
      isOneOf(c.utm_source, ["facebook"]) && isOneOf(c.utm_medium, ["group"]),
  },
  {
    tag: "ss_src_page",
    matches: (c) =>
      isOneOf(c.utm_source, ["facebook", "youtube"]) &&
      isOneOf(c.utm_medium, ["organic"]),
  },
];

export function resolveSourceTag(serialized: unknown): SourceTagResolution {
  const campaign = parseCampaignWire(serialized);
  if (!hasAny(campaign)) {
    return { kind: "direct", tag: "ss_src_direct", campaign };
  }
  for (const rule of SOURCE_TAG_RULES) {
    if (rule.matches(campaign)) {
      return { kind: "resolved", tag: rule.tag, campaign };
    }
  }
  return { kind: "unmapped", campaign };
}

export function serializeCampaign(campaign: CampaignSet): string {
  const params = new URLSearchParams();
  for (const key of CAMPAIGN_KEYS) {
    const value = campaign[key];
    if (typeof value === "string" && value) params.set(key, value);
  }
  return params.toString();
}
