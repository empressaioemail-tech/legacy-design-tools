/**
 * Type-level tests for the registration contract. These tests don't
 * exercise runtime behavior; they prove the type system rejects
 * incorrect registrations at compile time. Failure here means a future
 * editor lets developers register atoms that violate Spec 20 §4.
 *
 * The mechanism is `@ts-expect-error` markers — zero new tooling, runs
 * inside the existing vitest pass.
 */

import { describe, it, expect } from "vitest";
import type { AtomRegistration } from "../registration";
import { createAtomRegistry } from "../registry";
import type { ContextSummary } from "../context";

describe("type-level registration contract", () => {
  it("a complete registration typechecks", () => {
    const reg: AtomRegistration<"task", ["card", "compact"]> = {
      entityType: "task",
      domain: "sprint",
      supportedModes: ["card", "compact"],
      defaultMode: "card",
      composition: [],
      contextSummary: async (): Promise<ContextSummary<"task">> => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    };
    expect(reg.entityType).toBe("task");
  });

  it("a registration missing contextSummary fails to typecheck", () => {
    // @ts-expect-error - contextSummary is required
    const reg: AtomRegistration<"task", ["card"]> = {
      entityType: "task",
      domain: "sprint",
      supportedModes: ["card"],
      defaultMode: "card",
      composition: [],
    };
    expect(reg).toBeDefined();
  });

  it("a registration missing composition fails to typecheck", () => {
    // The composition field is required in A0 (Spec 20 §F: every
    // registration must declare the composition layer of the four-layer
    // contract — pass `composition: []` to declare 'no children').
    // @ts-expect-error - composition is required
    const reg: AtomRegistration<"task", ["card"]> = {
      entityType: "task",
      domain: "sprint",
      supportedModes: ["card"],
      defaultMode: "card",
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    };
    expect(reg).toBeDefined();
  });

  it("a registration with defaultMode not in supportedModes fails to typecheck", () => {
    const reg: AtomRegistration<"task", ["card"]> = {
      entityType: "task",
      domain: "sprint",
      supportedModes: ["card"],
      // @ts-expect-error - "compact" is not in supportedModes ["card"]
      defaultMode: "compact",
      composition: [],
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    };
    expect(reg).toBeDefined();
  });

  it("a registration missing domain fails to typecheck", () => {
    // @ts-expect-error - domain is required (recon B3 → required)
    const reg: AtomRegistration<"task", ["card"]> = {
      entityType: "task",
      supportedModes: ["card"],
      defaultMode: "card",
      composition: [],
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    };
    expect(reg).toBeDefined();
  });

  it("registry.register() rejects a non-literal (widened) entityType", () => {
    // The `LiteralString<TType>` guard on `register()` rejects widened
    // `string` entity types so the registry can narrow the resolved
    // type. Here we deliberately widen the variable to `string` — the
    // `register` call must error.
    const registry = createAtomRegistry();
    const widenedEntityType: string = "task";
    registry.register({
      // @ts-expect-error - non-literal entityType is rejected by register()'s LiteralString guard
      entityType: widenedEntityType,
      domain: "sprint",
      supportedModes: ["card"] as const,
      defaultMode: "card",
      composition: [],
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    });
    expect(registry).toBeDefined();
  });

  it("a ContextSummary missing historyProvenance fails to typecheck", () => {
    // The history anchoring layer of the four-layer contract (Spec 20
    // §F) is surfaced into context through `ContextSummary.historyProvenance`
    // — a required field carrying { latestEventId, latestEventAt }
    // (and optional chainHash) sourced from the EventAnchoringService.
    // Omitting it must fail to typecheck so registrations cannot
    // silently expose context that hides the audit chain.
    // @ts-expect-error - historyProvenance is required on ContextSummary
    const summary: ContextSummary<"task"> = {
      prose: "",
      typed: {},
      keyMetrics: [],
      relatedAtoms: [],
      scopeFiltered: false,
    };
    expect(summary).toBeDefined();

    // Likewise, a registration whose contextSummary returns a value
    // missing historyProvenance must fail to typecheck via the return
    // type of the contextSummary function.
    const reg: AtomRegistration<"task", ["card"]> = {
      entityType: "task",
      domain: "sprint",
      supportedModes: ["card"],
      defaultMode: "card",
      composition: [],
      // @ts-expect-error - returned ContextSummary missing historyProvenance
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        scopeFiltered: false,
      }),
    };
    expect(reg).toBeDefined();
  });

  it("resolve() narrows the literal entityType in the success branch", () => {
    const registry = createAtomRegistry();
    registry.register({
      entityType: "task" as const,
      domain: "sprint",
      supportedModes: ["card"] as const,
      defaultMode: "card",
      composition: [],
      contextSummary: async () => ({
        prose: "",
        typed: {},
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: { latestEventId: "", latestEventAt: "" },
        scopeFiltered: false,
      }),
    });
    const result = registry.resolve("task" as const);
    if (result.ok) {
      // Type-level: registration.entityType is narrowed to "task".
      const t: "task" = result.registration.entityType;
      expect(t).toBe("task");
    } else {
      throw new Error("expected resolve to succeed");
    }
  });
});
