import { describe, it, expect } from "vitest";
import { resolveComposition } from "./composition";
import { createAtomRegistry } from "./registry";
import type { AtomRegistration, AtomReference } from "./registration";

function makeStub<TType extends string>(
  entityType: TType,
  composition: AtomRegistration<TType, ["card"]>["composition"] = [],
): AtomRegistration<TType, ["card"]> {
  return {
    entityType,
    domain: "test",
    supportedModes: ["card"],
    defaultMode: "card",
    composition,
    contextSummary: async () => ({
      prose: "",
      typed: {},
      keyMetrics: [],
      relatedAtoms: [],
      historyProvenance: { latestEventId: "", latestEventAt: "" },
      scopeFiltered: false,
    }),
  };
}

describe("resolveComposition", () => {
  it("resolves a single child edge with id picking", () => {
    const registry = createAtomRegistry();
    const taskReg = makeStub("task");
    const boardReg = makeStub("sprint-board", [
      { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
    ]);
    registry.register(taskReg);
    registry.register(boardReg);

    const parentRef: AtomReference = {
      kind: "atom",
      entityType: "sprint-board",
      entityId: "b1",
    };
    const result = resolveComposition(
      boardReg,
      parentRef,
      { tasks: [{ id: "t1", title: "First" }, { id: "t2", title: "Second" }] },
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.children).toHaveLength(2);
      expect(result.children[0]?.reference).toMatchObject({
        kind: "atom",
        entityType: "task",
        entityId: "t1",
        mode: "compact",
      });
    }
  });

  it("supports multi-child composition", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task"));
    registry.register(makeStub("blocker"));
    const sprintReg = makeStub("sprint-board", [
      { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
      { childEntityType: "blocker", childMode: "compact", dataKey: "blockers" },
    ]);
    registry.register(sprintReg);

    const result = resolveComposition(
      sprintReg,
      { kind: "atom", entityType: "sprint-board", entityId: "b1" },
      {
        tasks: [{ id: "t1" }],
        blockers: [{ id: "b1" }, { id: "b2" }],
      },
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.children).toHaveLength(3);
      expect(result.children.map((c) => c.reference.entityType)).toEqual([
        "task",
        "blocker",
        "blocker",
      ]);
    }
  });

  it("synthesizes a fallback id when no candidate field is present", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task"));
    const reg = makeStub("sprint-board", [
      { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
    ]);
    registry.register(reg);
    const result = resolveComposition(
      reg,
      { kind: "atom", entityType: "sprint-board", entityId: "b1" },
      { tasks: [{ title: "no id here" }] },
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.children[0]?.reference.entityId).toBe("b1-tasks-0");
    }
  });

  it("treats a missing dataKey as zero children", () => {
    const registry = createAtomRegistry();
    registry.register(makeStub("task"));
    const reg = makeStub("sprint-board", [
      { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
    ]);
    registry.register(reg);
    const result = resolveComposition(
      reg,
      { kind: "atom", entityType: "sprint-board", entityId: "b1" },
      {}, // no `tasks` key
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.children).toEqual([]);
  });

  it("returns a structured error when a child type is not registered", () => {
    const registry = createAtomRegistry();
    const reg = makeStub("sprint-board", [
      { childEntityType: "task", childMode: "compact", dataKey: "tasks" },
    ]);
    registry.register(reg);
    const result = resolveComposition(
      reg,
      { kind: "atom", entityType: "sprint-board", entityId: "b1" },
      { tasks: [{ id: "t1" }] },
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.childEntityType).toBe("task");
    }
  });

  it("silently skips forwardRef edges whose child is still unregistered", () => {
    // Spec 20 decision #3: a parent that opts an edge into `forwardRef`
    // is opting in to "produce zero children for this edge until the
    // child catalog atom registers" rather than crashing the resolver.
    // The other (concrete) edge must still resolve normally.
    const registry = createAtomRegistry();
    registry.register(makeStub("snapshot"));
    const engagementReg = makeStub("engagement", [
      {
        childEntityType: "snapshot",
        childMode: "compact",
        dataKey: "snapshots",
      },
      {
        childEntityType: "submission",
        childMode: "compact",
        dataKey: "submissions",
        forwardRef: true,
      },
    ]);
    registry.register(engagementReg);

    const result = resolveComposition(
      engagementReg,
      { kind: "atom", entityType: "engagement", entityId: "e1" },
      {
        snapshots: [{ id: "s1" }, { id: "s2" }],
        submissions: [{ id: "should-be-ignored" }],
      },
      registry,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Two snapshot children; zero submission children even though we
      // passed `submissions` rows, because the child atom is not
      // registered. Future submission sprint will register `submission`
      // and these refs will start surfacing without code changes here.
      expect(result.children).toHaveLength(2);
      for (const child of result.children) {
        expect(child.reference.entityType).toBe("snapshot");
      }
    }
  });
});
