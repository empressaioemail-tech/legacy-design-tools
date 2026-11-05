/**
 * A13c: one ICC usage-ledger row per shown citation, written to plan review's
 * ledger (`POST /api/icc/usage`, plan-review PR #61).
 *
 * Inert unless both ICC_USAGE_LEDGER_URL and ICC_USAGE_LEDGER_TOKEN are set.
 * Fire-and-forget with a short timeout: it never blocks or fails a response,
 * and it logs failures by request id and count only (never citation text).
 * Ids only go out: bookId and sectionId. No ICC text is read or sent.
 */
import { isIccTitleAtom, isIccTitleIdentifier } from "@workspace/codes/iccTitles";
import { logger } from "./logger";

export type IccUsageSurface = "findings" | "brief" | "chat" | "connector-card";

export interface IccUsageCitation {
  bookId: string;
  sectionId: string;
}

export interface RecordIccUsageInput {
  requestId: string;
  /** The signed-in user's stable id. Null means not signed in: nothing is sent. */
  authorizedUser: string | null | undefined;
  surface: IccUsageSurface;
  citations: ReadonlyArray<IccUsageCitation>;
}

const PRODUCT = "smart-site";
const USAGE_PATH = "/api/icc/usage";
const TIMEOUT_MS = 3000;
const MAX_CITATIONS = 500;

/**
 * Ledger book id and section id for a code atom, or null when the atom is not
 * an ICC title or has no section. The book id is the ICC content slug from the
 * atom's source URL when it has one (for example IBC2021P1), else its code book.
 */
export function iccCitationFromAtom(a: {
  codeBook?: string | null;
  sectionNumber?: string | null;
  sourceUrl?: string | null;
  jurisdictionKey?: string | null;
  codeSource?: string | null;
}): IccUsageCitation | null {
  if (!isIccTitleAtom(a)) return null;
  const sectionId = a.sectionNumber?.trim();
  if (!sectionId) return null;
  const slug = a.sourceUrl?.match(/^https?:\/\/[^/]*iccsafe\.org\/content\/([A-Za-z0-9]+)/i)?.[1];
  const bookId = slug ?? a.codeBook?.trim();
  if (!bookId) return null;
  return { bookId, sectionId };
}

function endpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith(USAGE_PATH) ? trimmed : `${trimmed}${USAGE_PATH}`;
}

/** Never rejects. Callers do not await it on the response path. */
export function recordIccUsage(input: RecordIccUsageInput): Promise<void> {
  const url = process.env["ICC_USAGE_LEDGER_URL"];
  const token = process.env["ICC_USAGE_LEDGER_TOKEN"];
  if (!url || !token) return Promise.resolve();
  const user = input.authorizedUser?.trim();
  if (!user || !input.requestId) return Promise.resolve();

  const seen = new Set<string>();
  const citations: IccUsageCitation[] = [];
  for (const c of input.citations) {
    if (!isIccTitleIdentifier(c.bookId) || !c.sectionId) continue;
    const key = `${c.bookId}\u0000${c.sectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ bookId: c.bookId, sectionId: c.sectionId });
    if (citations.length >= MAX_CITATIONS) break;
  }
  if (citations.length === 0) return Promise.resolve();

  const { requestId, surface } = input;
  try {
    return fetch(endpoint(url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-usage-caller": PRODUCT,
      },
      body: JSON.stringify({
        requestId,
        authorizedUser: user,
        product: PRODUCT,
        surface,
        citations,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).then(
      (r) => {
        if (!r.ok) {
          logger.warn(
            { requestId, surface, count: citations.length, status: r.status },
            "icc usage ledger write rejected",
          );
        }
      },
      () => {
        logger.warn(
          { requestId, surface, count: citations.length },
          "icc usage ledger write failed",
        );
      },
    );
  } catch {
    logger.warn(
      { requestId, surface, count: citations.length },
      "icc usage ledger write failed",
    );
    return Promise.resolve();
  }
}

type AtomLike = Parameters<typeof iccCitationFromAtom>[0];

/** Ledger ids for the ICC atoms in a list. Non-ICC atoms are dropped. */
export function iccCitationsFromAtoms(
  atoms: ReadonlyArray<AtomLike>,
): IccUsageCitation[] {
  return atoms.flatMap((a) => {
    const c = iccCitationFromAtom(a);
    return c ? [c] : [];
  });
}

/** Ledger ids for the ICC atoms whose `[[CODE:id]]` token appears in the answer text. */
export function iccCitationsCitedInText(
  text: string,
  atoms: ReadonlyArray<AtomLike & { id: string }>,
): IccUsageCitation[] {
  const cited = new Set(
    Array.from(text.matchAll(/\[\[CODE:([^\]]+)\]\]/g), (m) => m[1]!.trim()),
  );
  return iccCitationsFromAtoms(atoms.filter((a) => cited.has(a.id)));
}

/** Ledger ids for the ICC atoms that finding rows cite (code citations carry an atomId). */
export function iccCitationsForFindings(
  rows: ReadonlyArray<{ citations: unknown }>,
  iccByAtomId: ReadonlyMap<string, IccUsageCitation>,
): IccUsageCitation[] {
  const out: IccUsageCitation[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.citations)) continue;
    for (const c of row.citations as Array<{ atomId?: unknown } | null>) {
      const hit = typeof c?.atomId === "string" ? iccByAtomId.get(c.atomId) : undefined;
      if (hit) out.push(hit);
    }
  }
  return out;
}
