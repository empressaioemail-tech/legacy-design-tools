# `@workspace/empressa-atom`

The **Empressa atom framework**, foundation sprint A0. A self-contained
workspace library that ships the contract every Empressa atom must
satisfy: identity, context interface, composition declaration, and
history anchoring (Spec 20 §4 / §6 / §F).

A0 builds the framework only. **No catalog atoms** (engagement, snapshot,
sheet, parcel-briefing, bim-model, etc.) are registered — those land in
A1+. The deliverable here is the contract, the runtime that enforces it,
the schema the history layer writes into, and the test scaffolding A1+
sprints will use to prove their atoms comply.

## Eventual extraction

This package is the in-repo staging ground for `@empressaio/atom` v1.0.0,
the SDK extraction planned for milestone **M2-C**. The directory name
(`lib/empressa-atom/`) signals the destination; the package name and
`exports` map already match the future SDK shape.

## Import boundary

The boundary is one-way:

- `lib/empressa-atom/` may **not** import from `artifacts/*` or any other
  application package.
- `artifacts/*` will import from `@workspace/empressa-atom` once A1+
  starts registering atoms; in A0 there are no consumers.

This rule is enforced by `src/__tests__/integration.test.ts`, which
ripgreps for forbidden import paths.

## Public surface

```ts
import {
  createAtomRegistry,
  defaultScope,
  resolveMode,
  parseInlineReferences,
  serializeInlineReference,
  httpContextSummary,
  resolveComposition,
  PostgresEventAnchoringService,
  wrapForStorage,
  unwrapFromStorage,
  type AtomRegistration,
  type AtomMode,
  type AtomReference,
  type ContextSummary,
  type Scope,
  type AtomComposition,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
```

Testing utilities live behind a separate subpath so production bundles
never pull them in:

```ts
import {
  createTestRegistry,
  createInMemoryEventService,
  runAtomContractTests,
} from "@workspace/empressa-atom/testing";
```

## The four-layer contract

An atom registers with one structurally-typed object:

```ts
const taskAtom: AtomRegistration<"task", ["card", "compact", "expanded"]> = {
  // identity
  entityType: "task",
  domain: "sprint",

  // render-mode contract (type-level only in A0)
  supportedModes: ["card", "compact", "expanded"],
  defaultMode: "card",

  // context interface (Spec 20 §4)
  contextSummary: async (entityId, scope) => ({
    prose: `Task ${entityId}: …`,
    typed: { id: entityId /* …per-atom shape… */ },
    keyMetrics: [{ label: "Status", value: "open" }],
    relatedAtoms: [],
    historyProvenance: { latestEventId: "evt-…", latestEventAt: "2026-…" },
    scopeFiltered: false,
  }),

  // composition declaration (Spec 20 §F; multi-child)
  composition: [
    { childEntityType: "blocker", childMode: "compact", dataKey: "blockers" },
  ],
};

const registry = createAtomRegistry();
registry.register(taskAtom);
```

The compile-time guarantees:

- `defaultMode` must be a member of `supportedModes` (the type system
  enforces this — registrations with a mismatched default fail to
  typecheck).
- `entityType` is a literal string, narrowed all the way through
  `registry.resolve("task")` so consumers see the exact type back.
- `domain` is required (recon §B3 evolved from "optional and unread" to
  "required and queryable" via `registry.listByDomain(...)`).

## Scope at the call site

`contextSummary` always takes a second `Scope` argument:

```ts
interface Scope {
  audience: "ai" | "user" | "internal";
  requestor?: { kind: "user" | "agent"; id: string };
  asOf?: Date;
  permissions?: ReadonlyArray<string>;
}
```

Atoms that don't differentiate by scope ignore it and set
`scopeFiltered: false`. Tests use the `defaultScope()` helper.

## Composition

Composition is a multi-child declarative graph. The registry **consumes**
the field — `registry.validate()` walks every registration's composition
edges and reports any that point at an unregistered child entity type.
Use `resolveComposition(parent, parentRef, parentData, registry)` to
turn the declaration into a typed children list ready for render-side
iteration.

**Boot-time contract:** the application bootstrap MUST call
`registry.validate()` once after every `register()` call has run and
fail to start when the result is `{ ok: false }`. The registry does not
revalidate composition on each `register()` (the parent may legitimately
register before the child) and `resolve()` does not recheck on lookup,
so dangling cross-references would otherwise surface only at
composition-resolution time. Treating `validate()` as a hard boot gate
keeps the contract enforceable without paying its cost on every call.

## History (`EventAnchoringService`)

Every atom mutation flows through `EventAnchoringService.appendEvent`,
which writes one row to the new `atom_events` table. A0 implements the
service with a deterministic SHA-256 chain hash:

```
chainHash = sha256(JSON.stringify({
  prevHash, payload, occurredAt, eventType, actor
}))
```

`prevHash` links each event to the previous event for the same
`(entityType, entityId)` pair, producing a per-entity hash chain.

**Interface-stable / implementation-evolving.** The
`EventAnchoringService` interface is the Spec 20 §6 contract. The
deterministic SHA-256 implementation will be replaced with a real
cryptographic anchor (Merkle root + external ledger anchor) at M2-C
**without changing the consumer interface**. Mark sites that should be
revisited carry `TODO(M2-C):` markers.

## VDA wrapping (no-op in A0)

`wrapForStorage(value)` returns
`{ envelope: { version: 1, vdaApplied: false }, payload: value }` and
`unwrapFromStorage(stored)` returns `stored.payload`. A1+ atoms call
these from their write paths today; the no-op becomes a real envelope at
M2-C without consumer changes.

## Inline reference syntax

The chat layer embeds atoms in prose using `{{atom|type|id|label}}`:

```ts
parseInlineReferences("see {{atom|task|t1|Pick HVAC}}");
// → [
//     { kind: "text", text: "see " },
//     { kind: "atom", reference: { kind: "atom", entityType: "task", entityId: "t1", displayLabel: "Pick HVAC" }, raw: "{{atom|task|t1|Pick HVAC}}" }
//   ]

serializeInlineReference({ kind: "atom", entityType: "task", entityId: "t1", displayLabel: "Pick HVAC" });
// → "{{atom|task|t1|Pick HVAC}}"
```

The delimiter is `|` (DA-PI-1F1). The previous shape used `:` and could
not represent Spec 51 entityIds that themselves contain `:` (e.g.
`parcel-briefing:{parcelId}:{intentHash}`). The old shape is no longer
parsed — there is no dual-parse compatibility path.

## Testing utilities

Future A1+ atom registrations import the contract test suite to prove
their registration is well-formed in one function call:

```ts
import { describe } from "vitest";
import { runAtomContractTests } from "@workspace/empressa-atom/testing";
import { taskAtom } from "./task.reg";

describe("task atom contract", () => {
  runAtomContractTests(taskAtom, {
    withFixture: { entityId: "t1", setUp: seedTestData },
    alsoRegister: [/* any composition children */],
  });
});
```

The suite asserts:

1. identity is present and `entityType` is non-empty,
2. `defaultMode` is in `supportedModes`,
3. `contextSummary` returns a valid four-layer shape with
   `historyProvenance` and `scopeFiltered`,
4. every composition edge resolves against `alsoRegister + this`,
5. inline-reference round-trips for an instance of this atom.

`createInMemoryEventService()` provides an in-memory
`EventAnchoringService` for unit tests that don't need Postgres;
`createTestRegistry(initial)` is a convenience over `createAtomRegistry()`.

## What's NOT shipped in A0

The following surfaces are intentionally deferred. Each is tagged with
`TODO(M2-C):` in the source where the eventual implementation will land.

- **Catalog atom registrations.** No `engagement.reg.ts`,
  `snapshot.reg.ts`, etc. Catalog atoms are A1+ work.
- **React rendering layer.** A0 ships the type-level render-mode
  contract only. The `<AtomRenderer>`, `<AtomShell>`, per-mode
  components, focus-store wiring, and right-panel state machine all
  ship in a later sprint as a separate package
  (`@workspace/empressa-atom-react` or a `/react` subpath) that
  depends on this one — never the other way around.
- **Cryptographic anchoring of `atom_events`.** `chainHash` is
  deterministic SHA-256 today; the Merkle root + external anchor land
  at M2-C.
- **Real VDA backing.** `wrapForStorage` / `unwrapFromStorage` are
  no-ops; the real envelope, version chain, and tombstone semantics
  land at M2-C.
- **AI request path wiring.** `httpContextSummary` is shipped so atoms
  can fetch their typed payload from the server, but the AI prompt
  builder does not yet consult `registry.describeForPrompt()` — that
  wiring is A1+ work scoped against the first registered atom.
- **Empressa Demo migration.** Empressa Demo continues independently;
  convergence happens at M2-C.

## Relationship to Spec 20

| Spec 20 section | Implementation |
|---|---|
| §4 Identity / Context | `AtomRegistration`, `ContextSummary`, `Scope` |
| §5 Render modes | `AtomMode`, `resolveMode`, `FALLBACK_ORDER` (type-level only in A0) |
| §6 History | `EventAnchoringService`, `PostgresEventAnchoringService` |
| §F Composition | `AtomComposition`, `resolveComposition`, `registry.validate()` |
| §F Inline syntax | `parseInlineReferences`, `serializeInlineReference` |

Where Spec 20 and the Empressa Demo recon disagreed, Spec 20 won; the
recon informed ergonomics and pain-point avoidance. The locked decisions
are spelled out in the A0 task spec (`.local/tasks/task-8.md` §
"Architectural decisions").
