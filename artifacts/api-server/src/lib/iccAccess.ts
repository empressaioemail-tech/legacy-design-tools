/**
 * G-309: ICC content is for signed-in users only. A signed-in user is a
 * verified session whose requestor is a user. The anonymous applicant and
 * the dev snapshot-secret holder are not.
 */
import type { Request } from "express";
import { sql, type SQL } from "drizzle-orm";
import { codeAtoms, codeAtomSources } from "@workspace/db";

export function hasSignedInUser(req: Request): boolean {
  return req.session?.requestor?.kind === "user";
}

/** SQL predicate that is true for ICC-sourced code_atoms rows (needs the source join). */
export function iccAtomRowSql(): SQL {
  return sql`(${codeAtoms.sourceUrl} ~* '(^|[/.])iccsafe[.]org' OR ${codeAtoms.jurisdictionKey} = 'icc-model-code' OR ${codeAtomSources.sourceName} ~* '(^|[^a-z])icc([^a-z]|$)|international code council')`;
}

/** SQL predicate that keeps non-ICC rows for callers who are not signed in. */
export function notIccAtomRowSql(): SQL {
  return sql`NOT COALESCE(${iccAtomRowSql()}, FALSE)`;
}
