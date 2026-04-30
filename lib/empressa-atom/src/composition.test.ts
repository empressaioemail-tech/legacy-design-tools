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
});
