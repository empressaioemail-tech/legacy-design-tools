/**
 * T1-A (2026-10-22) — `returnTo` validation and the `auth_error` redirect.
 *
 * `returnTo` must be a same-site RELATIVE path. Anything else (absolute URLs,
 * protocol-relative `//host`, backslash tricks, control characters, `/api/*`
 * endpoints, over-long values) becomes `/`. The hauska-map BFF applies the
 * same rule to the Google start/callback state; this is the Cortex copy used
 * for the email code/link flow and the link-confirm page.
 */

const MAX_RETURN_TO_LENGTH = 1024;
const PROBE_ORIGIN = "https://return-to.invalid";

export function sanitizeReturnTo(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const s = raw.trim();
  if (!s || s.length > MAX_RETURN_TO_LENGTH) return "/";
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(s)) return "/";
  let url: URL;
  try {
    url = new URL(s, PROBE_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== PROBE_ORIGIN) return "/";
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The fixed vocabulary of `/?auth_error=` codes (shared API contract). */
export type PeAuthErrorCode =
  | "link_used"
  | "link_expired"
  | "google_cancelled"
  | "google_failed"
  | "state_expired"
  | "account_conflict";

/** `/?auth_error=<code>&returnTo=<sanitized>` — never a raw JSON page. */
export function authErrorRedirectPath(
  code: PeAuthErrorCode,
  returnTo?: unknown,
): string {
  const params = new URLSearchParams({ auth_error: code });
  const safe = sanitizeReturnTo(returnTo);
  if (safe !== "/") params.set("returnTo", safe);
  return `/?${params.toString()}`;
}
