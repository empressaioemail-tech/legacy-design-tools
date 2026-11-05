/**
 * G-309: ICC content is for signed-in users only. A signed-in user is a
 * verified session whose requestor is a user. The anonymous applicant and
 * the dev snapshot-secret holder are not. The session middleware also gives
 * every unauthenticated browser a `{ kind: "user", id: "anon_<hex>" }`
 * requestor; that ephemeral owner is not signed in either.
 */
import type { Request } from "express";
import { sql, type SQL } from "drizzle-orm";
import { codeAtoms, codeAtomSources } from "@workspace/db";
import { isIccSource } from "@workspace/icc-notice";
import { isIccTitleAtom } from "@workspace/codes/iccTitles";
import { isAnonymousOwnerId } from "./anonymousOwnerCookie";

export function hasSignedInUser(req: Request): boolean {
  const r = req.session?.requestor;
  return r?.kind === "user" && !!r.id && !isAnonymousOwnerId(r.id);
}

/** SQL predicate that is true for ICC-sourced code_atoms rows (needs the source join). */
export function iccAtomRowSql(): SQL {
  return sql`(${codeAtoms.sourceUrl} ~* '(^|[/.])iccsafe[.]org' OR ${codeAtoms.jurisdictionKey} = 'icc-model-code' OR ${codeAtomSources.sourceName} ~* '(^|[^a-z])icc([^a-z]|$)|international code council')`;
}

/** SQL predicate that keeps non-ICC rows for callers who are not signed in. */
export function notIccAtomRowSql(): SQL {
  return sql`NOT COALESCE(${iccAtomRowSql()}, FALSE)`;
}

/**
 * G-309 (Exhibit D §6): true when a code_atoms row is an ICC atom, by source
 * (host, jurisdiction key, source name) or by ICC title identifier. ICC text is
 * never returned to anyone, signed-in users included.
 */
export function isIccRow(r: {
  sourceUrl?: string | null;
  jurisdictionKey?: string | null;
  sourceName?: string | null;
  codeBook?: string | null;
  sectionNumber?: string | null;
  codeSource?: string | null;
}): boolean {
  return (
    isIccSource({
      sourceUrl: r.sourceUrl ?? undefined,
      jurisdictionKey: r.jurisdictionKey ?? undefined,
      sourceName: r.sourceName ?? undefined,
      codeSource: r.codeSource ?? undefined,
    }) ||
    isIccTitleAtom({
      codeBook: r.codeBook,
      sectionNumber: r.sectionNumber,
      jurisdictionKey: r.jurisdictionKey,
      codeSource: r.codeSource,
    })
  );
}
