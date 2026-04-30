/**
 * Hybrid retrieval over code_atoms.
 *
 * Two paths:
 *   1. Vector — when OPENAI_API_KEY is available, embed the query with the
 *      same model used at ingestion (text-embedding-3-small, 1536d) and
 *      cosine-rank atoms whose embedding is non-null.
 *   2. Lexical — fallback when no key is available, or when the vector path
 *      returns no results. Plain ILIKE on body + section_title with a small
 *      bag-of-words score (matches per term).
 *
 * Both paths are scoped to a jurisdiction key so cross-tenant leakage is
 * impossible.
 */

import { and, eq, sql, isNotNull } from "drizzle-orm";
import { db, codeAtoms, codeAtomSources } from "@workspace/db";
import { embedQuery } from "./embeddings";
import type { OrchestratorLogger } from "./orchestrator";

export interface RetrievedAtom {
  id: string;
  sourceName: string;
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sectionNumber: string | null;
  sectionTitle: string | null;
  body: string;
  sourceUrl: string;
  /** Higher = more relevant. For vector path: 1 - cosine_distance. For lexical: bag-of-words match count. */
  score: number;
  /** "vector" | "lexical" */
  retrievalMode: string;
}

/**
 * Minimum cosine-similarity score for a vector-retrieved atom to be eligible
 * for inclusion in the chat reference block (i.e. actually injected into the
 * LLM's system prompt as `<reference_code_atoms>`).
 *
 * Calibrated against the Grand County, UT Land Use Code corpus (215 atoms in
 * `LAND_USE`). For the canonical "what are the setbacks for this property"
 * query, the literal "Required Yards (Setbacks)" definition (§5.6) and the
 * residential setback table (§5.4) score in the 0.36–0.38 range — clearly
 * the most relevant hits, but well below the legacy 0.6 cutoff that was
 * picked before any HTML/zoning corpus existed (and was tuned for a different
 * embedding distribution entirely).
 *
 * 0.35 was chosen as a *soft floor* paired with the existing top-K limit
 * (caller-provided `limit`, default 8): we still take at most K results, but
 * drop anything below this score so genuinely irrelevant atoms don't pollute
 * the prompt. Empirically, on the same corpus, off-topic queries score
 * <0.30, so 0.35 keeps top-1..3 zoning hits while filtering noise.
 *
 * Lexical-fallback scores are integer match counts (not cosine similarities)
 * and are NOT subject to this threshold — `applyMinScore` only affects the
 * vector path. The DevAtomsProbe UI reads this constant via the probe
 * response so the operator-facing divider always matches the chat path.
 */
export const MIN_VECTOR_SCORE = 0.35;

export interface RetrieveOptions {
  jurisdictionKey: string;
  question: string;
  limit?: number;
  logger?: OrchestratorLogger;
  /**
   * When true (default), filter vector-path results below
   * {@link MIN_VECTOR_SCORE} before returning. The chat path uses the default
   * so weak matches never reach the LLM. The /dev/atoms/retrieve probe
   * passes `false` so the operator sees the full ranked list with the
   * threshold rendered as a visual divider.
   *
   * Has no effect on the lexical-fallback path (integer match counts are not
   * comparable to cosine similarities).
   */
  applyMinScore?: boolean;
}

export async function retrieveAtomsForQuestion(
  opts: RetrieveOptions,
): Promise<RetrievedAtom[]> {
  const limit = opts.limit ?? 8;
  const applyMinScore = opts.applyMinScore ?? true;
  const log = opts.logger;

  // 1. Try the vector path.
  const qVec = await embedQuery(opts.question, { logger: log });
  if (qVec) {
    const vecLiteral = sql.raw(`'[${qVec.join(",")}]'::vector`);
    const rows = await db
      .select({
        id: codeAtoms.id,
        sourceName: codeAtomSources.sourceName,
        jurisdictionKey: codeAtoms.jurisdictionKey,
        codeBook: codeAtoms.codeBook,
        edition: codeAtoms.edition,
        sectionNumber: codeAtoms.sectionNumber,
        sectionTitle: codeAtoms.sectionTitle,
        body: codeAtoms.body,
        sourceUrl: codeAtoms.sourceUrl,
        distance: sql<number>`(${codeAtoms.embedding} <=> ${vecLiteral})`.as("distance"),
      })
      .from(codeAtoms)
      .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
      .where(
        and(
          eq(codeAtoms.jurisdictionKey, opts.jurisdictionKey),
          isNotNull(codeAtoms.embedding),
        ),
      )
      .orderBy(sql`distance ASC`)
      .limit(limit);
    if (rows.length > 0) {
      // Hydrate first, then optionally apply the soft floor. The fallback
      // to lexical only fires when the *raw* DB query returned 0 rows
      // (empty corpus / no embeddings). If we filter every vector hit out
      // because nothing crossed the floor, that's a true negative — we
      // intentionally return [] rather than backfilling with lexical
      // matches that would be even less relevant.
      const hydrated = rows.map((r) => ({
        id: r.id,
        sourceName: r.sourceName,
        jurisdictionKey: r.jurisdictionKey,
        codeBook: r.codeBook,
        edition: r.edition,
        sectionNumber: r.sectionNumber,
        sectionTitle: r.sectionTitle,
        body: r.body,
        sourceUrl: r.sourceUrl,
        score: 1 - Number(r.distance ?? 1),
        retrievalMode: "vector",
      }));
      return applyMinScore
        ? hydrated.filter((r) => r.score >= MIN_VECTOR_SCORE)
        : hydrated;
    }
  }

  // 2. Lexical fallback.
  const terms = opts.question
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 8);
  if (terms.length === 0) return [];

  const allRows = await db
    .select({
      id: codeAtoms.id,
      sourceName: codeAtomSources.sourceName,
      jurisdictionKey: codeAtoms.jurisdictionKey,
      codeBook: codeAtoms.codeBook,
      edition: codeAtoms.edition,
      sectionNumber: codeAtoms.sectionNumber,
      sectionTitle: codeAtoms.sectionTitle,
      body: codeAtoms.body,
      sourceUrl: codeAtoms.sourceUrl,
    })
    .from(codeAtoms)
    .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
    .where(eq(codeAtoms.jurisdictionKey, opts.jurisdictionKey))
    .limit(500);

  const scored = allRows
    .map((r) => {
      const hay = `${r.sectionTitle ?? ""} ${r.sectionNumber ?? ""} ${r.body}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        // Count occurrences (cheap).
        let pos = 0;
        while (true) {
          const i = hay.indexOf(t, pos);
          if (i === -1) break;
          score++;
          pos = i + t.length;
        }
      }
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ r, score }) => ({
    id: r.id,
    sourceName: r.sourceName,
    jurisdictionKey: r.jurisdictionKey,
    codeBook: r.codeBook,
    edition: r.edition,
    sectionNumber: r.sectionNumber,
    sectionTitle: r.sectionTitle,
    body: r.body,
    sourceUrl: r.sourceUrl,
    score,
    retrievalMode: "lexical",
  }));
}

/**
 * Look up a small set of atoms by id, scoped to a jurisdiction. Used by the
 * chat route to expand user-attached referencedAtomIds.
 */
export async function getAtomsByIds(
  ids: string[],
  jurisdictionKey: string,
): Promise<RetrievedAtom[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: codeAtoms.id,
      sourceName: codeAtomSources.sourceName,
      jurisdictionKey: codeAtoms.jurisdictionKey,
      codeBook: codeAtoms.codeBook,
      edition: codeAtoms.edition,
      sectionNumber: codeAtoms.sectionNumber,
      sectionTitle: codeAtoms.sectionTitle,
      body: codeAtoms.body,
      sourceUrl: codeAtoms.sourceUrl,
    })
    .from(codeAtoms)
    .innerJoin(codeAtomSources, eq(codeAtomSources.id, codeAtoms.sourceId))
    .where(
      and(
        eq(codeAtoms.jurisdictionKey, jurisdictionKey),
        sql`${codeAtoms.id} = ANY(${sql.raw(`ARRAY[${ids.map((id) => `'${id.replace(/'/g, "''")}'::uuid`).join(",")}]`)})`,
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    sourceName: r.sourceName,
    jurisdictionKey: r.jurisdictionKey,
    codeBook: r.codeBook,
    edition: r.edition,
    sectionNumber: r.sectionNumber,
    sectionTitle: r.sectionTitle,
    body: r.body,
    sourceUrl: r.sourceUrl,
    score: 1,
    retrievalMode: "explicit",
  }));
}
