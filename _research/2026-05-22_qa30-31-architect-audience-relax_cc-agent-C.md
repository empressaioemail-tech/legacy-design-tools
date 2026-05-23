---
title: QA-30/31 — architect-audience relax on the customer-zero loop routes
date: 2026-05-22
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary
status: PR open, held for operator security review
related: [42_design_accelerator_program_plan, 43_cortex_qa_backlog, 20_agent_operating_rules]
---

# QA-30/31 — architect-audience relax — cc-agent-C

## PR

**[#83](https://github.com/empressaioemail-tech/legacy-design-tools/pull/83)** — `fix/qa-30-31-architect-audience-relax`, commit `126c222`. Off `origin/main` (`c4fec09`), built in an isolated `git worktree` at `p:/tmp/qa30-worktree` per the workspace-hygiene memory. **Flagged in the PR body for explicit operator security review** (mirroring PR #77's posture).

## What the bug was

Operator's 2026-05-22 ~21:05-21:08 UTC Cloud Run log pull on `cortex-api-00016-9bw` showed the customer-zero loop blocked by 403s on the architect-audience gate:

- `GET /api/engagements/:id/bim-model` → 403 `bim_model_requires_architect_audience` (×13; the FE poll behind the "Loading BIM model…" empty-state spinner)
- `GET /api/engagements/:id/renders` → 403 (×7)
- `GET /api/renders/credits` → 403 (×2)

The IFC POST itself succeeded. Same root cause class as PR #77 (P1-5): `middlewares/session.ts` fails every production session closed to `audience: "user"`, so any route gated on `audience === "internal"` is universally dead in prod regardless of the gate function's name.

## Routes relaxed (16 total, across 4 route files)

| File | Routes |
|---|---|
| `routes/bimModels.ts` | `GET /materializable-elements/:id/glb`; `GET`+`POST /engagements/:id/bim-model`; `POST /bim-models/:id/refresh`; `GET /bim-models/:id/divergences`; `POST /bim-models/:id/divergences/:divergenceId/resolve` |
| `routes/briefingSources.ts` | `GET /briefing-sources/:id/glb` |
| `routes/renders.ts` | `POST /engagements/:id/renders`; `GET /renders/credits`; `POST /renders/prompt-generator`; `GET /renders/:id`; `GET /render-outputs/:id/file`; `GET /engagements/:id/renders`; `POST /renders/:id/cancel` |
| `routes/submissionComments.ts` | `GET`+`POST /submissions/:id/comments` (design-tools `SubmissionDetailModal` → `lib/portal-ui/SubmissionCommentThread`) |

The Cloud Run log explicitly named four (`bim-model`, `renders`, `renders/credits`, `renders/prompt-generator`); the remaining twelve are sibling routes the grep of `requireArchitectAudience` usage surfaced as belonging to the same architect customer-zero loop UI (BIM viewer + materializable-element GLB + briefing-source GLB + Renders kickoff/list/output/cancel + submission-comments thread).

## Routes KEPT gated (9 total, across 3 route files) — with rationale

| File | Routes | Why kept |
|---|---|---|
| `routes/codes.ts` | `POST /codes/warmup/:key`, `POST /codes/embeddings/backfill` | Administrative cache-warming and embeddings backfill. Not architect customer-zero loop; no design-tools UI calls them. |
| `routes/decisions.ts` | `POST`+`GET /submissions/:id/decisions`, `GET /submissions/:id/issued-pdf` | Reviewer-side decision authoring. `grep` of `artifacts/design-tools/src/` returns zero hits for these paths or their hooks; the architect-side UI does not consume them today. If a read-side issued-PDF surface lands in the architect UI later, relax then. |
| `routes/reviewerAnnotations.ts` | 4 routes — `GET`/`POST`/`PATCH /submissions/:id/reviewer-annotations*` and `POST .../promote` | Reviewer scratch notes. Reviewer-only by design (the V1-2 Sprint D contract). The architect-loop UI never sees them. |

The shared `requireArchitectAudience` helper in `lib/audienceGuards.ts` stays (still called by these 9 routes). `renders.ts`'s inline copy of the helper is removed — it had no remaining callers after the relaxation.

## Tests

Every `expect(res.status).toBe(403)` + `expect(res.body.error).toBe("…_requires_architect_audience")` pair across the 5 affected test files flipped to a single `expect(res.status).not.toBe(403)`:

- `bim-models.test.ts` — 5 tests (all 6 bimModels routes; the GET/POST `/engagements/:id/bim-model` pair shares one test setup)
- `briefing-source-glb.test.ts` — 1 test
- `materializable-element-glb.test.ts` — 1 test
- `renders-gap-fill-route.test.ts` — 2 tests (credits + prompt-generator)
- `submission-comments.test.ts` — 2 tests (GET + POST)

11 existing tests updated. Plus **1 new `describe` block in `renders-gap-fill-route.test.ts`** — `"QA-30/31 — renders routes reachable without an internal audience"` — pinning the 5 additional renders routes that didn't previously have a 403 test (`POST /engagements/:id/renders`, `GET /renders/:id`, `GET /render-outputs/:id/file`, `GET /engagements/:id/renders`, `POST /renders/:id/cancel`). Each calls the route without `x-audience: internal` and asserts the response is not 403. Mirrors PR #77's consolidated "architect-workflow routes (P1-5)" coverage pattern.

Per-package `pnpm run typecheck` green (libs + api-server).

## Operator review note

This PR relaxes an audience gate that the prior V1-3 security review locked down — the original concern was "an applicant who reaches the briefing payload should not be able to fetch the materialized geometry / start renders / reply on the submission thread." It does **not** create new exposure beyond the app's current pre-auth state (production has no real auth — every session is already the anonymous applicant; IFC ingest already succeeds today; findings already auto-generate; the IFC POST is HMAC-authenticated independently). When a real auth layer lands, scope the relaxed routes to the engagement's own architect; the V1-3 concern restates itself at that point.

## Workspace hygiene

Worked in an isolated `git worktree` at `p:/tmp/qa30-worktree` off `origin/main` (`c4fec09`) per the recent `feedback_workspace_hygiene_recurrent_violation` memory — the main clone is the shared-with-cc-agent-R working tree where Phase 2's contamination happened. Branch and staged-set verified before commit; no surprises. The PR diff is exactly the 9 intended files (4 route files + 5 test files).

**Held for the operator. No self-merge, no self-deploy.** Operator drives the redeploy after merge using the same direct `gcloud` form already in use on `cortex-api-00016-9bw`.
