/**
 * G-309 wave 2: reasoning_atoms rows sourced from ICC return citations only.
 * No database needed: the db handle is a fake that returns planted rows.
 */
import { describe, it, expect, vi } from "vitest";

const planted = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@workspace/db", async () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.from = () => chain;
  chain.limit = () => Promise.resolve(planted.rows);
  chain.where = () => Object.assign(Promise.resolve(planted.rows), { limit: () => Promise.resolve(planted.rows) });
  return { db: chain, reasoningAtoms: new Proxy({}, { get: () => ({}) }) };
});

import {
  retrieveReasoningAtomById,
  retrieveReasoningAtomsForRefs,
  reasoningAtomToCodeSection,
} from "../reasoningAtoms/index";

function row(sourceUrl: string, sourceName: string) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    jurisdictionKey: "bastrop_tx",
    codeRef: "IBC-1612.3",
    edition: "IBC 2021",
    editionSlug: "ibc-2021",
    sources: [
      { url: sourceUrl, sourceName, edition: "IBC 2021", retrievedAt: "2026-01-01T00:00:00Z", verified: true },
    ],
    reasoning: "PLANTED-REASONING-TEXT",
    assertedConfidence: "0.9",
    verificationState: "verified",
    snippet: "PLANTED-SNIPPET-TEXT",
    displayMode: "deeplink",
    calibratedConfidence: null,
    sourceSetVersion: 1,
    calibrationStale: false,
    accessPolicy: "public",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("reasoning atoms: ICC rows are citation-only", () => {
  it("drops snippet and reasoning for an iccsafe.org source, keeps the citation", async () => {
    planted.rows = [row("https://codes.iccsafe.org/content/IBC2021P1/chapter-16", "codes.iccsafe.org")];
    const [atom] = await retrieveReasoningAtomsForRefs({ jurisdictionKey: "bastrop_tx", codeRefs: ["IBC-1612.3"] });
    expect(atom!.snippet).toBeNull();
    expect(atom!.reasoning).toBeNull();
    expect(atom!.codeRef).toBe("IBC-1612.3");
    expect(atom!.sources[0]!.url).toContain("iccsafe.org");
    const section = reasoningAtomToCodeSection(atom!);
    expect(section.snippet).toBeUndefined();
    expect(JSON.stringify(section)).not.toContain("PLANTED");
    const byId = await retrieveReasoningAtomById("00000000-0000-4000-8000-000000000001");
    expect(byId!.snippet).toBeNull();
  });

  it("drops text when the source is named ICC even if the host is not", async () => {
    planted.rows = [row("https://example.com/x", "ICC Digital Codes")];
    const [atom] = await retrieveReasoningAtomsForRefs({ jurisdictionKey: "bastrop_tx", codeRefs: ["IBC-1612.3"] });
    expect(atom!.snippet).toBeNull();
  });

  it("keeps the snippet for a non-ICC source", async () => {
    planted.rows = [row("https://floridabuilding.org/c/x", "floridabuilding.org")];
    const [atom] = await retrieveReasoningAtomsForRefs({ jurisdictionKey: "bastrop_tx", codeRefs: ["FBC-M601.6"] });
    expect(atom!.snippet).toBe("PLANTED-SNIPPET-TEXT");
    expect(reasoningAtomToCodeSection(atom!).snippet).toBe("PLANTED-SNIPPET-TEXT");
  });
});
