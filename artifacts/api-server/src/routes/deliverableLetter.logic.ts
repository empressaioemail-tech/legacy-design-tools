/**
 * Pure validation + section-array logic for the L3 `deliverable-letter`
 * routes (Cortex Lane C.4 / C.4.3). Free of `@workspace/db` and Express
 * imports so it is unit-testable without a database.
 *
 * Endpoint contract:
 * `doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`
 * §L3.
 */

import {
  LETTER_SECTION_KINDS,
  type LetterSection,
  type LetterSectionKind,
  type LetterSectionProvenance,
} from "@workspace/atoms-l-surface";

/** Discriminated result of a request-body parse. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** A fresh, all-empty provenance block for a new section. */
export function emptyProvenance(): LetterSectionProvenance {
  return {
    responseTaskIds: [],
    sheetContentExtractionIds: [],
    findingIds: [],
    adjudicationStateIds: [],
  };
}

/** True when `v` is one of the four `LetterSectionKind` values. */
export function isLetterSectionKind(v: unknown): v is LetterSectionKind {
  return (
    typeof v === "string" &&
    (LETTER_SECTION_KINDS as readonly string[]).includes(v)
  );
}

/** One section as supplied in the create body (no provenance yet). */
export interface InitialSectionInput {
  kind: LetterSectionKind;
  heading: string;
  content: string;
}

/** Parsed `POST /engagements/:id/deliverable-letters` body. */
export interface ParsedCreateLetterBody {
  title: string;
  sections: InitialSectionInput[];
  recipientActorId: string | null;
  actorId: string | null;
  principalActorId: string | null;
}

function parseOptionalString(
  raw: unknown,
  field: string,
): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: `invalid_${field}` };
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/** Validate `POST /engagements/:id/deliverable-letters` request body. */
export function parseCreateLetterBody(
  raw: unknown,
): ParseResult<ParsedCreateLetterBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;

  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return { ok: false, error: "invalid_title" };
  }

  const sections: InitialSectionInput[] = [];
  if (body.sections !== undefined && body.sections !== null) {
    if (!Array.isArray(body.sections)) {
      return { ok: false, error: "invalid_sections" };
    }
    for (const entry of body.sections) {
      if (!entry || typeof entry !== "object") {
        return { ok: false, error: "invalid_section" };
      }
      const s = entry as Record<string, unknown>;
      if (!isLetterSectionKind(s.kind)) {
        return { ok: false, error: "invalid_section_kind" };
      }
      if (typeof s.heading !== "string" || typeof s.content !== "string") {
        return { ok: false, error: "invalid_section" };
      }
      sections.push({ kind: s.kind, heading: s.heading, content: s.content });
    }
  }

  const recipientActorId = parseOptionalString(
    body.recipientActorId,
    "recipient_actor_id",
  );
  if (!recipientActorId.ok) return recipientActorId;
  const actorId = parseOptionalString(body.actorId, "actor_id");
  if (!actorId.ok) return actorId;
  const principalActorId = parseOptionalString(
    body.principalActorId,
    "principal_actor_id",
  );
  if (!principalActorId.ok) return principalActorId;

  return {
    ok: true,
    value: {
      title: body.title.trim(),
      sections,
      recipientActorId: recipientActorId.value,
      actorId: actorId.value,
      principalActorId: principalActorId.value,
    },
  };
}

/** Parsed `POST /deliverable-letters/:id/sections` body. */
export interface ParsedSectionUpsertBody {
  sectionIndex: number;
  kind: LetterSectionKind;
  heading: string;
  content: string;
}

/** Validate the section-upsert request body. */
export function parseSectionUpsertBody(
  raw: unknown,
): ParseResult<ParsedSectionUpsertBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.sectionIndex !== "number" ||
    !Number.isInteger(body.sectionIndex) ||
    body.sectionIndex < 0
  ) {
    return { ok: false, error: "invalid_section_index" };
  }
  if (!isLetterSectionKind(body.kind)) {
    return { ok: false, error: "invalid_section_kind" };
  }
  if (typeof body.heading !== "string" || typeof body.content !== "string") {
    return { ok: false, error: "invalid_section" };
  }
  return {
    ok: true,
    value: {
      sectionIndex: body.sectionIndex,
      kind: body.kind,
      heading: body.heading,
      content: body.content,
    },
  };
}

/**
 * Upsert a section by index into the ordered `sections` array.
 *
 * `sectionIndex` within the current array replaces that section's
 * `kind` / `heading` / `content` and **preserves its provenance**;
 * `sectionIndex` equal to the current array length appends a new
 * section with empty provenance; a larger index is rejected.
 */
export function upsertSection(
  sections: ReadonlyArray<LetterSection>,
  body: ParsedSectionUpsertBody,
): ParseResult<LetterSection[]> {
  if (body.sectionIndex > sections.length) {
    return { ok: false, error: "invalid_section_index" };
  }
  const next = sections.slice();
  if (body.sectionIndex === sections.length) {
    next.push({
      kind: body.kind,
      heading: body.heading,
      content: body.content,
      provenance: emptyProvenance(),
    });
  } else {
    const existing = next[body.sectionIndex]!;
    next[body.sectionIndex] = {
      kind: body.kind,
      heading: body.heading,
      content: body.content,
      provenance: existing.provenance,
    };
  }
  return { ok: true, value: next };
}

/** Parsed provenance-merge body — at least one id array must be present. */
export type ParsedProvenanceBody = Partial<{
  responseTaskIds: string[];
  sheetContentExtractionIds: string[];
  findingIds: string[];
  adjudicationStateIds: string[];
}>;

const PROVENANCE_KEYS = [
  "responseTaskIds",
  "sheetContentExtractionIds",
  "findingIds",
  "adjudicationStateIds",
] as const;

/** Validate the provenance-merge request body. */
export function parseProvenanceBody(
  raw: unknown,
): ParseResult<ParsedProvenanceBody> {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "invalid_request_body" };
  }
  const body = raw as Record<string, unknown>;
  const out: ParsedProvenanceBody = {};
  let supplied = 0;
  for (const key of PROVENANCE_KEYS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (
      !Array.isArray(value) ||
      !value.every((v) => typeof v === "string" && v.length > 0)
    ) {
      return { ok: false, error: `invalid_${key}` };
    }
    out[key] = value as string[];
    supplied++;
  }
  if (supplied === 0) {
    return { ok: false, error: "no_provenance_supplied" };
  }
  return { ok: true, value: out };
}

function dedupe(values: ReadonlyArray<string>): string[] {
  return [...new Set(values)];
}

/**
 * Merge atom references into a section's provenance, deduped. A
 * `sectionIndex` outside the current array is rejected.
 */
export function mergeProvenance(
  sections: ReadonlyArray<LetterSection>,
  sectionIndex: number,
  partial: ParsedProvenanceBody,
): ParseResult<LetterSection[]> {
  if (
    !Number.isInteger(sectionIndex) ||
    sectionIndex < 0 ||
    sectionIndex >= sections.length
  ) {
    return { ok: false, error: "invalid_section_index" };
  }
  const next = sections.slice();
  const sec = next[sectionIndex]!;
  next[sectionIndex] = {
    ...sec,
    provenance: {
      responseTaskIds: dedupe([
        ...sec.provenance.responseTaskIds,
        ...(partial.responseTaskIds ?? []),
      ]),
      sheetContentExtractionIds: dedupe([
        ...sec.provenance.sheetContentExtractionIds,
        ...(partial.sheetContentExtractionIds ?? []),
      ]),
      findingIds: dedupe([
        ...sec.provenance.findingIds,
        ...(partial.findingIds ?? []),
      ]),
      adjudicationStateIds: dedupe([
        ...sec.provenance.adjudicationStateIds,
        ...(partial.adjudicationStateIds ?? []),
      ]),
    },
  };
  return { ok: true, value: next };
}
