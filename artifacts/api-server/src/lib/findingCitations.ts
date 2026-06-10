/**
 * Shared finding citation wire validation — manual-create and override
 * paths must build/parse citations identically so arrow-two lineage
 * never starves on override.
 */

import { z } from "zod";

export const FindingCodeCitationWire = z.object({
  kind: z.literal("code-section"),
  atomId: z.string().min(1),
});

export const FindingSourceCitationWire = z.object({
  kind: z.literal("briefing-source"),
  id: z.string().min(1),
  label: z.string().min(1),
});

export const FindingCitationWire = z.discriminatedUnion("kind", [
  FindingCodeCitationWire,
  FindingSourceCitationWire,
]);

export type FindingCitationWireType = z.infer<typeof FindingCitationWire>;

/** Same citation assembly as POST /submissions/{id}/findings (~1434). */
export function buildFindingCitationsFromManualCreateBody(body: {
  codeCitation?: string | null;
  sourceCitation?: { id: string; label: string } | null;
}): FindingCitationWireType[] {
  const citations: FindingCitationWireType[] = [];
  const codeCitation = body.codeCitation?.trim();
  if (codeCitation) {
    citations.push({ kind: "code-section", atomId: codeCitation });
  }
  if (body.sourceCitation) {
    citations.push({
      kind: "briefing-source",
      id: body.sourceCitation.id,
      label: body.sourceCitation.label,
    });
  }
  return citations;
}

export function parseFindingCitationsArray(
  raw: unknown,
): { ok: true; citations: FindingCitationWireType[] } | { ok: false } {
  if (!Array.isArray(raw)) return { ok: false };
  const citations: FindingCitationWireType[] = [];
  for (const item of raw) {
    const parsed = FindingCitationWire.safeParse(item);
    if (!parsed.success) return { ok: false };
    citations.push(parsed.data);
  }
  return { ok: true, citations };
}

export function coerceStoredFindingCitations(
  raw: unknown,
): FindingCitationWireType[] {
  const parsed = parseFindingCitationsArray(raw);
  return parsed.ok ? parsed.citations : [];
}

/**
 * Override citations: explicit body replaces when non-empty; omitted or
 * empty array carries forward the original finding's citations (never
 * silently strip lineage).
 */
export function resolveOverrideFindingCitations(args: {
  bodyCitations: unknown | undefined;
  originalCitations: unknown;
}): { ok: true; citations: FindingCitationWireType[] } | { ok: false } {
  if (args.bodyCitations === undefined) {
    return {
      ok: true,
      citations: coerceStoredFindingCitations(args.originalCitations),
    };
  }
  const parsed = parseFindingCitationsArray(args.bodyCitations);
  if (!parsed.ok) return { ok: false };
  if (parsed.citations.length > 0) {
    return { ok: true, citations: parsed.citations };
  }
  return {
    ok: true,
    citations: coerceStoredFindingCitations(args.originalCitations),
  };
}
