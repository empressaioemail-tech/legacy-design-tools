# Fix round T1b — adversarial review findings on branch fix/t1-enforce-scoping (commit 288cb00)

You are continuing YOUR OWN work on branch `fix/t1-enforce-scoping` (already checked out here). The planner's adversarial review found four blockers, one of them a live security hole. Fix all four, push after every commit, delete this CURSOR_TASK.md before the final commit, then open the PR titled `fix(t1): scope gate-context verification; enforce rejects forged tenant claims only` (it was never opened).

## Finding 1 (BLOCKER): the route patterns never match at runtime

Your `GATE_FRONTED_ROUTE_PATTERNS` anchor at `^\/api\/...`, but these routers are mounted inside the `/api` parent router, so at runtime `req.path` is MOUNT-RELATIVE. Live-prod evidence (cortex log, 2026-07-07T13:01:31Z): the middleware logged `path: "/engagements/00000000-0000-4000-8000-000000000001/site-topography"` — no `/api` prefix. Every one of your patterns fails against that, `isGateFrontedRoute` returns false, and verification becomes a silent no-op on exactly the routes it must protect. Your tests pass because they construct paths WITH the `/api` prefix — false green.

Fix: match with an optional prefix, e.g. `/^(?:\/api)?\/engagements\/[^/]+\/site-topography(?:\/|$)/`, and rewrite the scoping tests to use the mount-relative form actually observed live (keep one absolute-form case for the optional-prefix branch).

## Finding 2 (BLOCKER): parcelBriefings routes are not in the pattern list

The six gate-fronted routers include `parcelBriefings.ts`, whose routes are `/engagements/:id/briefing`, `/briefing/generate`, `/briefing/status`, `/briefing/runs`, `/briefing/export.pdf`, `/briefing/sources...`. No pattern covers them; they lose verification entirely. Add `/^(?:\/api)?\/engagements\/[^/]+\/briefing(?:\/|$)/`.

## Finding 3 (BLOCKER): `/findings/:findingId/outcome` is missing

The verified route list from the six routers (planner-extracted from main):
```
/engagements/:id/briefing[...]
/engagements/:id/encumbrances/upload , /engagements/:id/encumbrances , /engagements/:id/encumbrances/clauses/:clauseId/verify
/engagements/:id/site-drainage[, /design-storms, /refresh]
/engagements/:id/site-topography[, /refresh]
/findings/:findingId/accept | /reject | /override | /outcome
/findings/outcome-observations
/submissions/:submissionId/findings[, /generate, /runs, /status]
```
Your `(accept|reject|override)` alternation omits `outcome`. Regenerate the whole pattern set from this list, not from memory.

## Finding 4 (SECURITY BLOCKER): forged plain headers survive enforce mode via req.serviceAuth

Mount order is `requireGateEngineServiceAuth` (which calls your `buildGateServiceAuth`) BEFORE `verifyGateContext`. So `req.serviceAuth` is populated from `resolveGateTenantContext(req)` at a moment when `req.gateContext` is still undefined — in enforce mode that falls through to the PLAIN-HEADER branch. Attack: send a VALID signed context for tenant A plus plain headers claiming tenant B. Your middleware verifies the signature (tenant A), logs `gate_context_mismatch` as a WARNING only, and passes; `req.serviceAuth.jurisdictionTenant` carries forged tenant B into every handler. The forgery hole T1 exists to close is still open.

Fix BOTH legs in `verifyGateContext` enforce mode:
1. Signed/plain mismatch → 401 `gate_context_mismatch` (in log mode keep the warn-only behavior).
2. After successful verification (enforce mode), overwrite `req.serviceAuth`'s `jurisdictionTenant`/`platformInternal` from the verified `req.gateContext` when `req.serviceAuth` exists, so no downstream reader can see pre-verification plain-header values.

Add tests: the tenant-A-signed + tenant-B-plain forgery case must 401 in enforce and only warn in log mode; a post-verification handler in enforce mode must observe the SIGNED tenant on `req.serviceAuth`.

## Constraints (unchanged)

EXIT-BOUNDED commands only (build/typecheck/targeted vitest; never dev/watch). DB-free unit tests only; CI is the merge authority. Do not change log-mode or off-mode behavior. Push immediately after the first commit.
