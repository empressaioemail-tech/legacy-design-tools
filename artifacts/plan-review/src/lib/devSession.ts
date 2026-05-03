/**
 * Dev-only `pr_session` cookie helpers.
 *
 * The api-server's `sessionMiddleware` honors a JSON-encoded
 * `pr_session` cookie when `NODE_ENV !== "production"` (and
 * fail-closes it in prod). Plan Review uses these helpers to let a
 * developer flip their browser session between a reviewer
 * (`audience: "internal"`) and an architect (`audience: "user"`)
 * without round-tripping a real auth flow — see Task #504 for the
 * end-to-end story.
 *
 * Hidden from production at the call site (`import.meta.env.PROD`).
 * Production keeps the anonymous applicant default; this file is a
 * dev/preview ergonomics seam, not an auth bypass.
 */

export type DevAudience = "internal" | "user";

const COOKIE_NAME = "pr_session";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const entry of cookies) {
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq);
    if (key === name) return decodeURIComponent(entry.slice(eq + 1));
  }
  return null;
}

/**
 * Resolve the audience encoded into the current `pr_session` cookie,
 * if any. Returns `null` for missing / malformed cookies — callers
 * treat that as "anonymous default" (which the api-server resolves
 * to `audience: "user"`).
 */
export function getDevSessionAudience(): DevAudience | null {
  const raw = readCookie(COOKIE_NAME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const aud = (parsed as Record<string, unknown>)["audience"];
      if (aud === "internal" || aud === "user") return aud;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Write the dev `pr_session` cookie for the requested audience.
 * Path is `/` so the cookie travels with both the artifact preview
 * (e.g. `/plan-review/...`) and the API (`/api/...`) on the shared
 * proxy. Cookie is non-`HttpOnly` (the server doesn't sign it yet
 * either) so it can be read back via {@link getDevSessionAudience}.
 */
export function setDevSessionAudience(audience: DevAudience): void {
  if (typeof document === "undefined") return;
  const requestor = {
    kind: "user" as const,
    id: audience === "internal" ? "dev-reviewer" : "dev-architect",
  };
  const value = encodeURIComponent(
    JSON.stringify({ audience, requestor }),
  );
  // 30-day expiry so the choice survives reloads in dev.
  const maxAge = 60 * 60 * 24 * 30;
  document.cookie = `${COOKIE_NAME}=${value}; path=/; max-age=${maxAge}; samesite=lax`;
}

/**
 * Clear the dev `pr_session` cookie so the next request falls back
 * to the anonymous applicant default (`audience: "user"`).
 */
export function clearDevSessionCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0; samesite=lax`;
}
