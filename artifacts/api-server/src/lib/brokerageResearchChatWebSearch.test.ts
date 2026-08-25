/**
 * PE research-chat labeled web-search backup.
 *
 * Violate unlabeled web text before claiming the check works.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??=
    "postgres://unused:unused@localhost:5432/unused";
});
import {
  assertLabeledWebSearchCitation,
  corpusCoversCivicTopic,
  detectCivicChatTopics,
  resetResearchChatCivicHttpForTests,
  resolveResearchChatWebSearchBackup,
  RESEARCH_CHAT_WEBSEARCH_DISCLOSURE,
  RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED,
  setResearchChatCivicHttpForTests,
} from "./brokerageResearchChatWebSearch";

afterEach(() => {
  resetResearchChatCivicHttpForTests();
});

describe("detectCivicChatTopics", () => {
  it("detects school assignment", () => {
    expect(detectCivicChatTopics("What school assignment is this parcel in?")).toEqual([
      "schools",
    ]);
  });

  it("detects ADU / additional unit / subdivision", () => {
    expect(detectCivicChatTopics("Can I add an additional unit or subdivide?")).toEqual([
      "adu_subdivision",
    ]);
  });
});

describe("corpusCoversCivicTopic", () => {
  it("treats a corpus ADU atom as a hit", () => {
    expect(
      corpusCoversCivicTopic(
        [
          {
            atomDid: "did:hauska:atom:bastrop-adu-1",
            label: "Accessory dwelling units",
            snippet: "ADUs shall comply with setbacks.",
          },
        ],
        "adu_subdivision",
      ),
    ).toBe(true);
  });

  it("does not treat a websearch id as corpus", () => {
    expect(
      corpusCoversCivicTopic(
        [
          {
            atomDid: "websearch:civic:bastrop-isd",
            label: "Bastrop ISD",
            snippet: "school assignment",
          },
        ],
        "schools",
      ),
    ).toBe(false);
  });
});

describe("assertLabeledWebSearchCitation — violate unlabeled web text", () => {
  it("fails when web text has no websearch: id and no disclosure", () => {
    expect(() =>
      assertLabeledWebSearchCitation({
        atomDid: "did:hauska:atom:made-up",
        label: "BISD says Chestnut is at Mina",
        snippet: "Check the ISD yourself.",
        source: "corpus",
      }),
    ).toThrow(/unlabeled web text/);
  });

  it("passes a websearch: citation with disclosure", () => {
    expect(() =>
      assertLabeledWebSearchCitation({
        atomDid: "websearch:civic:bastrop-isd",
        label: "Bastrop ISD — web-search backup, not a Hauska atom",
        snippet: RESEARCH_CHAT_WEBSEARCH_DISCLOSURE,
        disclosure: RESEARCH_CHAT_WEBSEARCH_DISCLOSURE,
        source: "websearch",
      }),
    ).not.toThrow();
  });
});

describe("resolveResearchChatWebSearchBackup", () => {
  it("corpus-hit does not fire websearch", async () => {
    setResearchChatCivicHttpForTests(async () => {
      throw new Error("civic fetch must not run on corpus-hit");
    });
    const out = await resolveResearchChatWebSearchBackup({
      jurisdictionKey: "bastrop_tx",
      message: "Can the buyer add an ADU?",
      existingAtoms: [
        {
          atomDid: "did:hauska:atom:bastrop-adu-1",
          label: "Accessory dwelling units",
          snippet: "ADUs shall comply with setback requirements.",
        },
      ],
    });
    expect(out.atoms).toEqual([]);
    expect(out.localCodeSource).toBe("none");
    expect(out.degradedReasons).toEqual([]);
  });

  it("known corpus-miss fires a websearch: citation", async () => {
    setResearchChatCivicHttpForTests(async (url) => {
      if (url.includes("bastropisd.org") || url.includes("tea.texas.gov")) {
        return {
          status: 200,
          body: "<html><body><h1>Bastrop ISD</h1><p>Attendance zones for Bastrop ISD campuses.</p></body></html>",
          finalUrl: url,
        };
      }
      return { status: 404, body: "", finalUrl: url };
    });
    const out = await resolveResearchChatWebSearchBackup({
      jurisdictionKey: "bastrop_tx",
      message: "What school assignment is 906 Chestnut in?",
      existingAtoms: [],
    });
    expect(out.localCodeSource).toBe("websearch");
    expect(out.atoms.length).toBeGreaterThan(0);
    for (const atom of out.atoms) {
      assertLabeledWebSearchCitation({
        atomDid: atom.atomDid,
        label: atom.label,
        snippet: atom.snippet,
        disclosure: atom.webSearchBackup?.disclosure,
        source: atom.webSearchBackup ? "websearch" : undefined,
      });
      expect(atom.atomDid.startsWith("websearch:")).toBe(true);
      expect(atom.webSearchBackup?.verificationState).toBe("unverified");
      expect(atom.webSearchBackup?.retrievedAt).toMatch(/^\d{4}-/);
      expect(atom.webSearchBackup?.confidence).toBe(0.35);
    }
  });

  it("fetch failure is a labeled degrade, not a silent skip", async () => {
    setResearchChatCivicHttpForTests(async () => {
      throw new Error("network down");
    });
    const out = await resolveResearchChatWebSearchBackup({
      jurisdictionKey: "bastrop_tx",
      message: "What school assignment is this?",
      existingAtoms: [],
    });
    expect(out.atoms).toEqual([]);
    expect(out.localCodeSource).toBe("none");
    expect(out.degradedReasons).toContain(RESEARCH_CHAT_WEBSEARCH_FETCH_DEGRADED);
  });
});
