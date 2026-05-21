---
title: Cortex QA WS-C session summary — in-app agent tool-use
date: 2026-05-20
agent: cc-agent-C
repo: legacy-design-tools
kind: session-summary-draft
status: draft (planner relocates to doc_repo with canonical frontmatter)
dispatch: _dispatches/2026-05-20_cc-agent-C_cortex_qa_wsc_in_app_agent.md
related: [43_cortex_qa_backlog, 42_design_accelerator_program_plan, 44_mcp_cortex_architecture_map, 28_mcp_first_product_design]
---

# Cortex QA WS-C session summary — in-app agent tool-use

WS-C gave the in-app Cortex chat panel tool-use. Before this sprint
`artifacts/api-server/src/routes/chat.ts` called the Anthropic API with
zero tool use: it built a prompt, streamed text, and ended. It is now a
bounded Anthropic tool-use agentic loop wired to cortex-api's own tables
and the L-surface contract, executing every tool in-process (never via
the hauska-mcp-server, per the WSA.1 topology). All four QA items in
scope — QA-07, QA-08 (review portion), QA-09, QA-11 (push portion) —
are addressed. The model stays `claude-sonnet-4-6`; SSE streaming to the
panel is preserved; a plain question that needs no tool takes one pass,
identical to the pre-WS-C behaviour.

## What shipped, by sub-task

### WSC.1 — tool-use agentic loop

`chat.ts` replaces the single `anthropic.messages.stream(...)` call with
a loop: stream a turn, drain text deltas to SSE, read `finalMessage()`;
if `stop_reason === "tool_use"` run each tool in-process, append the
`tool_result`, and continue; otherwise finish with `[DONE]`. The loop is
capped at 8 tool-calling iterations — when the budget is spent the model
is fed an error result for every pending call and given one final
no-tools turn to close out. `max_tokens` rose from 1024 to 4096 to give
agent reviews and multi-turn conversations headroom. A new module
`routes/chatAgentTools.ts` owns the tool definitions, the `ToolContext`,
the `executeAgentTool` dispatcher, the handlers, and the provenance
constants. The system prompt is augmented in `chat.ts` (leaving
`@workspace/codes/promptFormatter.ts` untouched) with tool-use guidance
plus the ambient context line.

### WSC.2 — read tools and platform awareness (QA-07)

Ambient context: the open engagement was already known (request
`engagementId` plus the engagement framework atom); the active tab is
now sent too and woven into the system-prompt ambient line. Nine read
tools cover the platform surfaces: `list_sheets`, `read_sheet`,
`list_findings`, `list_submissions`, `list_snapshots`,
`list_response_tasks`, `list_detail_callout_specs`,
`list_product_spec_references`, `read_site_context`. Each is a thin
drizzle read against the same tables the routes and atoms use, scoped to
the request's engagement (`engagementId` is bound from `ToolContext`,
never a tool input, so cross-engagement access is impossible). The
sheet-select checkbox is a corner overlay added in `SheetGrid.tsx`; it
reuses the existing `attachedSheets` path, so a ticked sheet rides into
chat context exactly as the "Ask Claude" affordance already did, and
`read_sheet` covers sheets the operator did not tick.

### WSC.3 — write-back to response tasks (QA-08, QA-11)

One write tool, `create_response_tasks`, takes a `tasks` array (length 1
single, more for batch). Its handler reuses `parseCreateResponseTaskBody`
from `responseTasks.logic.ts` for validation parity, inserts into the
`responseTasks` table exactly as the L1 route does (state `open`), and
records the `response-task.opened` audit event through the shared
`recordLSurfaceEvent`. No L-surface route file was modified and no new
persistence was added. QA-08 and QA-11 share this mechanism: the agent
runs a review in the chat panel, then calls `create_response_tasks` per
item; the FE invalidates the L1 query and navigates to the Response
Tasks tab, where the task list renders.

### WSC.4 — AI-assisted spec drafting (QA-09)

Two draft-only tools, `draft_detail_callout_spec` and
`draft_product_spec_reference`, validate the agent's draft against the
same schema the L4/L5 routes use (`DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA`,
`ESR_NUMBER_RE`) and emit an `agent_draft` SSE event. The engagement
page routes the draft to the matching manual form, opens its existing
create dialog pre-filled, and shows an "AI-populated — review before
saving" banner. The operator reviews, edits, and submits through the
unchanged manual form path; the persisted atom is operator-created. The
manual form path is fully intact. The agent never directly persists an
L4 or L5 atom — see the flag to the planner below.

### WSC.5 — quality gate, provenance, reversibility, agent-action log

Every response-task the agent creates carries provenance on the atom
itself, with no new columns (the dispatch's "no new backend persistence"
constraint). `actorId` is set to the constant `cortex-in-app-agent` —
the explicit AI-origin marker that distinguishes an agent-created task
from an operator-created one, rendered as an "AI-drafted" badge on the
Response Tasks tab. `principalActorId` is the operator (session
requestor id, else a fallback). `findingId` / `sourceClientCommentId`
record the source the task derived from; `createdAt` is the timestamp;
the agent's one-line reasoning plus a delimited AI-drafted note and the
propagated finding severity/confidence are appended to the `description`
as a provenance footer. The `response-task.opened` audit event payload
carries the structured form (`aiOriginated: true`, `agentReasoning`,
`severity`, `confidence`, source ids).

Reversibility: an agent-created response-task reverses to the L1
`cancelled` state (`open → cancelled` is a legal transition) through the
existing `POST /api/response-tasks/:id/state` route. The agent-action
log is session-only FE state in the engagements store, fed by
`agent_action` SSE events; the chat panel renders an "Agent actions this
session" section, each row with a one-click Reverse button.

## Files changed

New: `artifacts/api-server/src/routes/chatAgentTools.ts` (tool
definitions, dispatcher, handlers, provenance constants),
`artifacts/api-server/src/__tests__/chat-agent-tools.test.ts`.

Modified backend: `routes/chat.ts` (agentic loop, SSE event types,
`activeTab`, system-prompt augmentation), `__tests__/setup.ts`
(`response_tasks` added to the truncate list), `__tests__/chat.test.ts`
and `__tests__/chat-roundtrip.test.ts` (Anthropic mock now exposes
`finalMessage()`).

Modified frontend: `store/engagements.ts` (agent-action log, spec-draft
staging, new SSE event handling, `activeTab` on the request, reverse
helper), `components/ClaudeChat.tsx` (agent-action log with reverse,
tool-use status lines), `components/SheetGrid.tsx` (sheet-select
checkbox), `pages/EngagementDetail.tsx` (active-tab plumbing,
spec-draft routing to the L4/L5 tab, L1-query invalidation plus
navigation to the Response Tasks tab on an agent write),
`components/engagement-detail/ResponseTasksTab.tsx` (AI-drafted badge),
`DetailCalloutSpecsTab.tsx` and `ProductSpecReferencesTab.tsx`
(AI-populate path into the create dialog). Three FE test files updated
for the new store fields / `SheetGrid` prop.

## Deviations from the dispatch / plan

The plan said to add `activeTab` to `SendChatMessageBody` in
`@workspace/api-zod`. That schema is Orval-generated; editing it would
be overwritten on regeneration. `SendChatMessageBody` is a non-strict
`z.object`, so an extra field passes validation and is stripped from
`parse.data` — `activeTab` is therefore read directly off `req.body` in
`chat.ts` with a small inline guard, and `@workspace/api-zod` is not
touched.

Query invalidation and tab navigation were planned inside `ClaudeChat`.
They moved to `EngagementDetail` (which already holds a `QueryClient`)
because the standalone `ClaudeChat.test.tsx` renders `ClaudeChat`
without a `QueryClientProvider`; keeping `ClaudeChat` react-query-free
avoids breaking that suite. `EngagementDetail` now watches the
agent-action list and invalidates the L1 query plus navigates on a
fresh create. Behaviour to the operator is unchanged.

## Flag to the planner — WSC.5 reversibility for L4/L5

Per the operator decision confirmed this session, L4 detail-callout-spec
and L5 product-spec-reference are draft-only: the agent prepares a
form-valid draft, the operator reviews and saves it through the manual
form, and the persisted atom is operator-created. The agent never
directly writes a spec atom. The L4 and L5 endpoints have no DELETE or
archive route, so a direct agent-write of a spec atom would have been
irreversible and would have needed the WSC.5 confirm-step exception.
Routing through the operator-submitted form removes that case entirely —
there is no irreversible agent spec-write, so the confirm-step exception
is unnecessary, not skipped. This is the WSC.5 resolution and is the
item flagged for the planner.

## Verification

`pnpm run typecheck` is green across all six artifacts and the lib
build — this is the per-artifact `tsc -p X --noEmit` gate CI runs.

The vitest suites were not run in this environment: the api-server route
tests need a Postgres (`TEST_DATABASE_URL` / `DATABASE_URL` is unset
here), and vitest needs the workstation's documented Windows native-deps
workaround. `chat-agent-tools.test.ts` (WSC.1-WSC.5, scripted Anthropic
tool-use mock against the real-Postgres harness) and the updated
`chat.test.ts` / `chat-roundtrip.test.ts` mocks are written and ready;
CI is the authoritative runner for them.

End-to-end manual check, once an environment is available: open an
engagement with a snapshot, ask the agent to review the project and push
tasks (they appear in the Response Tasks tab with an AI-drafted badge
and survive reload), cancel one from the agent-action log, ask for a
room-finish detail callout (the L4 form opens pre-filled, then persists
on submit), and tick a sheet checkbox to confirm the agent can answer a
question about that sheet.
