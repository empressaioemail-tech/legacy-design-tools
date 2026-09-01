/**
 * Detect portal WAF / rate-limit blocks — fail closed, no retry or UA rotation.
 */

export const PORTAL_ACCESS_BLOCKED_CODE = "portal-access-blocked";

export function isPortalAccessBlockedStatus(status: number): boolean {
  return status === 403 || status === 429;
}

const WAF_PAGE_INDICATORS = [
  "cf-challenge",
  "cf-chl-bypass",
  "cloudflare",
  "attention required",
  "access denied",
  "request blocked",
  "rate limit",
  "too many requests",
  "please enable javascript",
  "bot detection",
  "akamai",
  "incapsula",
  "distil",
  "perimeterx",
] as const;

export function isWafOrRateLimitPageContent(content: string): boolean {
  const lower = content.toLowerCase();
  return WAF_PAGE_INDICATORS.some((indicator) => lower.includes(indicator));
}
