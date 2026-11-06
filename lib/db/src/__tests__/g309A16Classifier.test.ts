/**
 * G-309 A16: the purge scripts' classes agree with the shared classifier
 * (lib/codes/src/iccTitles.ts isIccRow / isIccReasoningRow) on a table of
 * sample rows. No database. Synthetic values only.
 *
 * The expected classes are the ones that ran at 420276c3: icc-title (edition's
 * leading token is an ICC title, or jurisdiction is icc-model-code),
 * icc-source-link (an ICC-host / ICC-named source link); edition_slug and
 * code_ref never classify.
 *
 * Modules load through dynamic imports with computed paths so this file stays
 * inside lib/db's tsc rootDir.
 */
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const href = (rel: string) => pathToFileURL(path.join(REPO, rel)).href;

type Row = Record<string, unknown>;
let lib: {
  loadClassifier: () => Promise<unknown>;
  classifyCodeAtom: (c: unknown, r: Row) => string[];
  classifyReasoningAtom: (c: unknown, r: Row) => { cls: string | null; codeRefOnlyTitle: boolean };
};
let shared: {
  isIccRow: (r: Row) => boolean;
  isIccReasoningRow: (r: Row) => boolean;
};
let c: unknown;

beforeAll(async () => {
  lib = await import(/* @vite-ignore */ href("scripts/g309/a16-lib.mjs"));
  shared = await import(/* @vite-ignore */ href("lib/codes/src/iccTitles.ts"));
  c = await lib.loadClassifier();
});

const reasoning: Array<{ name: string; row: Row; cls: string | null }> = [
  { name: "IBC edition", row: { edition: "IBC 2021", sources: [] }, cls: "icc-title" },
  { name: "lowercase ibc edition", row: { edition: "ibc 2018" }, cls: "icc-title" },
  { name: "icc-model-code jurisdiction", row: { edition: "TAS 2012", jurisdiction_key: "icc-model-code" }, cls: "icc-title" },
  { name: "TAS with ICC link", row: { edition: "TAS 2012", sources: [{ url: "https://codes.iccsafe.org/x" }] }, cls: "icc-source-link" },
  { name: "FBC with ICC-named source", row: { edition: "FBC 2023", sources: [{ sourceName: "ICC Digital Codes" }] }, cls: "icc-source-link" },
  { name: "title and link both: title wins", row: { edition: "IRC 2021", sources: [{ url: "https://codes.iccsafe.org/x" }] }, cls: "icc-title" },
  { name: "TAS no ICC link", row: { edition: "TAS 2012", sources: [{ url: "https://example.gov/tas" }] }, cls: null },
  { name: "FBCEB null sources", row: { edition: "FBCEB 2023", sources: null }, cls: null },
  { name: "A117.1", row: { edition: "A117.1 2017", sources: [] }, cls: null },
  { name: "lookalike host", row: { edition: "TAS 2012", sources: [{ url: "https://noticcsafe.org/x" }] }, cls: null },
  { name: "code_ref alone never classifies", row: { edition: "TAS 2012", code_ref: "IBC 1004", sources: [] }, cls: null },
  { name: "edition_slug alone never classifies", row: { edition: "TAS 2012", edition_slug: "ibc-2021", sources: [] }, cls: null },
];

const codeAtoms: Array<{ name: string; row: Row; icc: boolean }> = [
  { name: "ICC host source", row: { source_url: "https://codes.iccsafe.org/a", code_book: "Austin LDC" }, icc: true },
  { name: "ICC-named source", row: { source_name: "ICC Digital Codes", code_book: "Local" }, icc: true },
  { name: "ICC title book", row: { code_book: "IBC 2021", source_url: "https://example.gov/a" }, icc: true },
  { name: "ICC title in section number", row: { section_number: "IRC R301", code_book: "Local" }, icc: true },
  { name: "icc-model-code jurisdiction", row: { jurisdiction_key: "icc-model-code", code_book: "Local" }, icc: true },
  { name: "municipal", row: { source_url: "https://library.municode.com/tx", code_book: "Austin LDC", section_number: "25-1" }, icc: false },
  { name: "all null", row: {}, icc: false },
];

describe("G-309 A16 script classes agree with the shared classifier", () => {
  for (const t of reasoning) {
    it(`reasoning_atoms: ${t.name}`, () => {
      const k = lib.classifyReasoningAtom(c, t.row);
      expect(k.cls).toBe(t.cls);
      const sharedVerdict = shared.isIccReasoningRow({
        edition: t.row.edition,
        jurisdictionKey: t.row.jurisdiction_key,
        sources: t.row.sources,
      });
      expect(sharedVerdict).toBe(t.cls !== null);
    });
  }
  for (const t of codeAtoms) {
    it(`code_atoms: ${t.name}`, () => {
      expect(lib.classifyCodeAtom(c, t.row).length > 0).toBe(t.icc);
      expect(
        shared.isIccRow({
          sourceUrl: t.row.source_url,
          sourceName: t.row.source_name,
          jurisdictionKey: t.row.jurisdiction_key,
          codeBook: t.row.code_book,
          sectionNumber: t.row.section_number,
        }),
      ).toBe(t.icc);
    });
  }
});
