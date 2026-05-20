# @workspace/atoms-l-surface

Cortex L1-L6 atom-instance shapes — TypeScript types, Zod schemas, and
the advisory helpers (`deliverableLetterCompleteness`,
`isLegalPushTransition`) for the Lane C.4 L-surface work.

## Why this exists (mirror, not import)

The canonical L-atom shapes live in `@hauska-engine/atoms` (hauska-engine
`packages/atoms/src/instances.ts`). That package is `private: true` with
`publishConfig: "none"` — it is on no registry, so legacy-design-tools
cannot depend on it.

Per the 2026-05-19 Lane C.4 planner decision (Path A), the seven L-atom
shapes are **mirrored verbatim** into this package instead. The mirror
is pinned to `@hauska-engine/atoms@0.6.0` (hauska-engine SHA `7ed915c`).

## Re-mirror discipline

`src/instances.ts` is a verbatim copy of the engine source. The source
of truth remains `hauska-engine/packages/atoms/src/instances.ts`.

- On an engine `@hauska-engine/atoms` version bump, re-mirror.
- Do not change the schemas locally. If a schema needs to change,
  surface the drift to the planner first — the endpoint contract
  (`doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`)
  is the cross-repo seam and is contract-grade.

`src/__tests__/conformance.test.ts` parses contract-derived example
payloads against these schemas, so shape drift fails CI rather than
diverging silently at runtime.

## Scope

Mirrored: `BaseAtomInstance` plus the entire Cortex L1-L6 block
(response-task, sheet-content-extraction, attached-document,
deliverable-letter, detail-callout-spec, product-spec-reference,
deliverable-letter-render). The code-corpus (Bump 1) atoms are not
mirrored — they are not consumed here. `AccessPolicy` is defined
locally as the stable ADR-017 four-value union (the engine imports it
from `@hauska-engine/atom-contract-pin`, also unpublished).
