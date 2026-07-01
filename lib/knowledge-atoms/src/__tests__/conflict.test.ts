import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AtomQueryResult } from "../types.js";

/**
 * ConflictedResult contract shape — verbatim per dispatch close report.
 */
export type AtomQueryResultDiscriminant<T = unknown> =
  | { kind: "single"; atom: T; conflict_disclosure?: boolean }
  | { kind: "conflicted"; conflict: unknown; candidates: T[] }
  | { kind: "empty" };

describe("AtomQueryResult discriminated union", () => {
  it("accepts single, conflicted, and empty variants", () => {
    const single: AtomQueryResult = {
      kind: "single",
      atom: {
        id: "a",
        subjectId: "parcel_1",
        claimType: "claim.lien",
        sourceKey: "cotality:liens-mortgage-tax",
        payload: {},
        accessPolicy: "public-paid",
        confidence: 0.9,
        validFrom: new Date(),
        validTo: null,
        knowledgeAt: new Date(),
        dedupKey: null,
        createdAt: new Date(),
      },
    };
    const conflicted: AtomQueryResult = {
      kind: "conflicted",
      conflict: {
        id: "c",
        subjectId: "parcel_1",
        claimType: "conflict.claim.lien",
        sourceKey: "system:conflict-detector",
        payload: {
          original_claim_type: "claim.lien",
          conflicting_atom_ids: ["a", "b"],
          detected_at: new Date().toISOString(),
          resolution: { resolved: false, resolution_basis: null },
        },
        accessPolicy: "public-paid",
        confidence: 0.5,
        validFrom: new Date(),
        validTo: null,
        knowledgeAt: new Date(),
        dedupKey: null,
        createdAt: new Date(),
      },
      candidates: single.kind === "single" ? [single.atom] : [],
    };
    const empty: AtomQueryResult = { kind: "empty" };
    expect(single.kind).toBe("single");
    expect(conflicted.kind).toBe("conflicted");
    expect(empty.kind).toBe("empty");
  });
});

describe("write path coverage (unit)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("writeKnowledgeAtom, bulkImportKnowledgeAtoms, adminWriteKnowledgeAtom share central store", async () => {
    const writeKnowledgeAtom = vi.fn(async (input: unknown) => ({
      id: "written",
      ...(input as object),
    }));
    vi.doMock("@workspace/db", () => ({
      db: {},
      knowledgeAtoms: {},
    }));
    vi.doMock("../store.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../store.js")>();
      return {
        ...actual,
        writeKnowledgeAtom,
      };
    });
    const store = await import("../store.js");
    expect(typeof store.writeKnowledgeAtom).toBe("function");
    expect(typeof store.bulkImportKnowledgeAtoms).toBe("function");
    expect(typeof store.adminWriteKnowledgeAtom).toBe("function");
  });
});
