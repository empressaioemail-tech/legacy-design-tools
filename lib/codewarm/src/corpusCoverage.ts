import { and, eq, ilike, or } from "drizzle-orm";
import { db, codeAtoms } from "@workspace/db";
import { corpusCoversTarget } from "@workspace/codes";
import type { WebCodeReviewTarget } from "@workspace/codes";
import type { CodewarmManifestEntry } from "./types";
import { manifestEntryToTarget } from "./targets";

export interface CorpusCoverageHit {
  covered: boolean;
  corpusAtomId?: string;
  corpusSourceUrl?: string;
  label?: string;
}

/** Jurisdiction-scoped corpus lookup — same precedence gate as finding path. */
export async function queryCorpusCoverage(args: {
  jurisdictionKey: string;
  entry: CodewarmManifestEntry;
}): Promise<CorpusCoverageHit> {
  const target = manifestEntryToTarget(args.entry);
  const sectionToken =
    args.entry.codeRef.split("-").pop() ?? args.entry.codeRef;

  const rows = await db
    .select({
      id: codeAtoms.id,
      sectionNumber: codeAtoms.sectionNumber,
      sectionTitle: codeAtoms.sectionTitle,
      sourceUrl: codeAtoms.sourceUrl,
    })
    .from(codeAtoms)
    .where(
      and(
        eq(codeAtoms.jurisdictionKey, args.jurisdictionKey),
        or(
          ilike(codeAtoms.sectionNumber, `%${sectionToken}%`),
          ilike(codeAtoms.sectionTitle, `%${args.entry.title.slice(0, 24)}%`),
        ),
      ),
    )
    .limit(5);

  const labels = rows.map(
    (r) =>
      `${args.entry.codeRef} — ${r.sectionTitle ?? r.sectionNumber ?? ""}`.trim(),
  );

  const matchedIndex = labels.findIndex((_label, i) =>
    corpusCoversTarget([labels[i]!], target),
  );
  const hit = matchedIndex >= 0 ? rows[matchedIndex]! : null;

  if (hit) {
    return {
      covered: true,
      corpusAtomId: hit.id,
      corpusSourceUrl: hit.sourceUrl,
      label: labels[matchedIndex],
    };
  }

  return { covered: false };
}
