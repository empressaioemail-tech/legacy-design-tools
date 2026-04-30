import { describe, it, expect } from "vitest";
import { createAtomRegistry, AtomNotRegisteredError } from "./registry";
import type { AtomRegistration } from "./registration";
import { defaultScope } from "./scope";

function makeStub<TType extends string>(
  entityType: TType,
  domain: string,
  composition: AtomRegistration<TType, ["card"]>["composition"] = [],
): AtomRegistration<TType, ["card"]> {
  return {
    entityType,
    domain,
    supportedModes: ["card"],
    defaultMode: "card",
    composition,
    contextSummary: async () => ({
      prose: `stub ${entityType}`,
      typed: {},
      keyMetrics: [],
      relatedAtoms: [],
      historyProvenance: { latestEventId: "", latestEventAt: "" },
      scopeFiltered: false,
    }),
  };
}

describe("createAtomRegistry", () => {
  it("registers and resolves an atom", async () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task", "sprint"));
    const result = registry.resolve("task");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registration.entityType).toBe("task");
      // contextSummary still callable through the resolved registration.
      const ctx = await result.registration.contextSummary("id-1", defaultScope());
      expect(ctx.prose).toBe("stub task");
    }
  });

  it("returns a typed error when missing", () => {
    const registry = createAtomRegistry();
    const result = registry.resolve("missing-thing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AtomNotRegisteredError);
      expect(result.error.entityType).toBe("missing-thing");
    }
  });

  it("rejects double-registration of the same entityType", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task", "sprint"));
    expect(() => registry.register(makeStub("task", "sprint"))).toThrow(
      /already registered/,
    );
  });

  it("listByDomain filters by domain", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task", "sprint"));
    registry.register(makeStub("blocker", "sprint"));
    registry.register(makeStub("lead", "crm"));
    expect(registry.listByDomain("sprint")).toHaveLength(2);
    expect(registry.listByDomain("crm")).toHaveLength(1);
    expect(registry.listByDomain("nope")).toHaveLength(0);
  });

  it("describeForPrompt enumerates atoms with composes list", () => {
    const registry = createAtomRegistry();
    registry.register(
      makeStub("task", "sprint"),
    );
    registry.register(
      makeStub("sprint-board", "sprint", [
        { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
      ]),
    );
    const desc = registry.describeForPrompt();
    const board = desc.find((d) => d.entityType === "sprint-board");
    expect(board).toBeDefined();
    expect(board?.composes).toEqual(["task"]);
  });

  it("describeForPrompt surfaces declared eventTypes (and normalizes a missing field to [])", () => {
    // One atom declares an event vocabulary, the other omits the field
    // entirely — the catalog must still expose both as arrays so
    // downstream tooling can map without a nullish guard.
    const registry = createAtomRegistry();
    const withEvents: AtomRegistration<"task", ["card"]> = {
      ...makeStub("task", "sprint"),
      eventTypes: ["task.created", "task.completed"] as const,
    };
    registry.register(withEvents);
    registry.register(makeStub("blocker", "sprint"));
    const desc = registry.describeForPrompt();
    const task = desc.find((d) => d.entityType === "task");
    const blocker = desc.find((d) => d.entityType === "blocker");
    expect(task?.eventTypes).toEqual(["task.created", "task.completed"]);
    expect(blocker?.eventTypes).toEqual([]);
  });

  it("validate detects dangling composition refs", () => {
    const registry = createAtomRegistry();
    registry.register(
      makeStub("sprint-board", "sprint", [
        { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
      ]),
    );
    const result = registry.validate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        parentEntityType: "sprint-board",
        childEntityType: "task",
      });
    }
  });

  it("validate succeeds when every composition target is registered", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task", "sprint"));
    registry.register(
      makeStub("sprint-board", "sprint", [
        { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
      ]),
    );
    expect(registry.validate().ok).toBe(true);
  });

  it("validate skips composition edges marked forwardRef", () => {
    // Spec 20 decision #3: a parent may declare a child atom slated for
    // a later sprint via `forwardRef: true`. The boot validator must
    // treat that edge as deliberate and not as a dangling reference.
    const registry = createAtomRegistry();
    registry.register(
      makeStub("engagement", "plan-review", [
        {
          childEntityType: "submission",
          childMode: "compact",
          dataKey: "submissions",
          forwardRef: true,
        },
      ]),
    );
    expect(registry.validate().ok).toBe(true);
  });

  it("validate still flags non-forwardRef dangling edges in a parent that has a forwardRef sibling edge", () => {
    // The opt-out is per-edge, not per-parent: a typo in a non-marked
    // edge must still fail the boot even when a sibling edge on the
    // same parent is forward-ref. This guards against blanket-disabling
    // validation by the presence of any forwardRef declaration.
    const registry = createAtomRegistry();
    registry.register(
      makeStub("engagement", "plan-review", [
        {
          childEntityType: "submission",
          childMode: "compact",
          dataKey: "submissions",
          forwardRef: true,
        },
        {
          // Not a forward ref — `snapshot` is misspelled (typo) and
          // not registered. Validate must surface this as an error.
          childEntityType: "snapshto",
          childMode: "compact",
          dataKey: "snapshots",
        },
      ]),
    );
    const result = registry.validate();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        parentEntityType: "engagement",
        childEntityType: "snapshto",
        dataKey: "snapshots",
      });
    }
  });
});
