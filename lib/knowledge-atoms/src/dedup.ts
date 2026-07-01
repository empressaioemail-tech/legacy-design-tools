import type { KnowledgeAtomCheckScope } from "./types.js";

/** Dedup key includes full date range — different ranges are distinct absence atoms. */
export function verifiedAbsenceDedupKey(args: {
  subjectId: string;
  claimType: string;
  sourceKey: string;
  checkScope: KnowledgeAtomCheckScope;
  checkDate: string;
}): string {
  const { checkScope } = args;
  return [
    args.subjectId,
    args.claimType,
    args.sourceKey,
    checkScope.jurisdiction,
    checkScope.record_type,
    checkScope.date_range_start,
    checkScope.date_range_end,
    checkDateIsoDay(args.checkDate),
  ].join("|");
}

function checkDateIsoDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export function intervalsOverlap(
  a: { validFrom: Date; validTo: Date | null },
  b: { validFrom: Date; validTo: Date | null },
): boolean {
  const aEnd = a.validTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bEnd = b.validTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.validFrom.getTime() <= bEnd && b.validFrom.getTime() <= aEnd;
}
