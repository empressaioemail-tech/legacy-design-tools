import { readFileSync } from "node:fs";
import type {
  CodewarmGroundingFlag,
  CodewarmManifestEntry,
  CodewarmManifestSection,
} from "./types";

interface RawManifest {
  codes?: Array<{
    code: string;
    edition: string;
    sections: CodewarmManifestSection[];
  }>;
  groups?: Array<{
    group?: string;
    grounding?: CodewarmGroundingFlag;
    edition: string;
    sections: CodewarmManifestSection[];
  }>;
}

function normalizeGrounding(
  section: CodewarmManifestSection,
  groupDefault?: CodewarmGroundingFlag,
): CodewarmGroundingFlag {
  return section.grounding ?? groupDefault ?? "web-groundable";
}

function toEntry(
  section: CodewarmManifestSection,
  code: string,
  edition: string,
  groupDefault?: CodewarmGroundingFlag,
): CodewarmManifestEntry {
  const sectionCode = section.code ?? code;
  const bareSection = section.section.trim();
  const codeRef = bareSection.startsWith(sectionCode)
    ? bareSection
    : `${sectionCode}-${bareSection}`;
  return {
    codeRef,
    code: sectionCode,
    edition,
    title: section.title,
    discipline: section.discipline,
    traffic: section.traffic,
    verify: section.verify,
    grounding: normalizeGrounding(section, groupDefault),
  };
}

function parseManifestDoc(doc: RawManifest): CodewarmManifestEntry[] {
  const entries: CodewarmManifestEntry[] = [];

  for (const block of doc.codes ?? []) {
    for (const section of block.sections) {
      entries.push(toEntry(section, block.code, block.edition));
    }
  }

  for (const group of doc.groups ?? []) {
    for (const section of group.sections) {
      const code = section.code ?? group.group ?? "UNKNOWN";
      const edition = section.edition ?? group.edition;
      entries.push(toEntry(section, code, edition, group.grounding));
    }
  }

  return entries;
}

function readQuotedOrBare(inner: string, key: string): string | undefined {
  const quoted = inner.match(new RegExp(`\\b${key}:\\s*"([^"]+)"`));
  if (quoted) return quoted[1];
  const bare = inner.match(new RegExp(`\\b${key}:\\s*([^,"]+)`));
  return bare?.[1]?.trim().replace(/^"|"$/g, "");
}

/** Parse inline `{ section: X, title: "Y", ... }` rows from catalog YAML. */
function parseInlineSectionRow(line: string): CodewarmManifestSection | null {
  const match = line.match(/-\s*\{([^}]+)\}/);
  if (!match) return null;
  const inner = match[1]!;
  const section = readQuotedOrBare(inner, "section");
  const title = readQuotedOrBare(inner, "title");
  if (!section || !title) return null;
  const grounding = readQuotedOrBare(inner, "grounding") as
    | CodewarmGroundingFlag
    | undefined;
  return {
    section,
    title,
    discipline: readQuotedOrBare(inner, "discipline"),
    traffic: readQuotedOrBare(inner, "traffic"),
    code: readQuotedOrBare(inner, "code"),
    edition: readQuotedOrBare(inner, "edition"),
    verify: /\bverify:\s*true\b/.test(inner),
    grounding,
  };
}

/**
 * Minimal catalog-YAML parser for `_catalog/codes/manifest_*.yaml` inline rows.
 * JSON manifests are also supported.
 */
export function parseCodewarmManifestYaml(raw: string): CodewarmManifestEntry[] {
  const entries: CodewarmManifestEntry[] = [];
  let currentCode = "";
  let currentEdition = "";
  let groupGrounding: CodewarmGroundingFlag | undefined;
  let inGroups = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("groups:")) {
      inGroups = true;
      continue;
    }
    if (trimmed.startsWith("codes:")) {
      inGroups = false;
      continue;
    }
    const codeMatch = trimmed.match(/^-?\s*code:\s*(\S+)/);
    if (codeMatch && !trimmed.includes("{")) {
      currentCode = codeMatch[1]!.replace(/"/g, "");
      continue;
    }
    const groupMatch = trimmed.match(/^-\s*group:\s*(\S+)/);
    if (groupMatch) {
      currentCode = groupMatch[1]!.replace(/"/g, "");
      currentEdition = "";
      groupGrounding = undefined;
      continue;
    }
    const editionMatch = trimmed.match(/^edition:\s*"?([^"#]+)"?/);
    if (editionMatch && !trimmed.includes("{")) {
      currentEdition = editionMatch[1]!.trim();
      continue;
    }
    const groundingMatch = trimmed.match(/^grounding:\s*(\S+)/);
    if (groundingMatch && !trimmed.includes("{")) {
      groupGrounding = groundingMatch[1] as CodewarmGroundingFlag;
      continue;
    }
    const sectionRow = parseInlineSectionRow(trimmed);
    if (!sectionRow) continue;

    const code = sectionRow.code ?? currentCode;
    const edition = sectionRow.edition ?? currentEdition;
    if (!edition || !code) continue;

    entries.push(
      toEntry(
        sectionRow,
        code,
        edition,
        inGroups ? groupGrounding : undefined,
      ),
    );
  }

  return entries;
}

/** Parse a manifest file (JSON or catalog YAML) into flat reference entries. */
export function parseCodewarmManifest(manifestPath: string): CodewarmManifestEntry[] {
  const raw = readFileSync(manifestPath, "utf-8");
  if (manifestPath.endsWith(".json")) {
    return parseManifestDoc(JSON.parse(raw) as RawManifest);
  }
  try {
    return parseManifestDoc(JSON.parse(raw) as RawManifest);
  } catch {
    return parseCodewarmManifestYaml(raw);
  }
}
