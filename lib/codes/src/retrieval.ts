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

export interface RetrieveOptions {
  jurisdictionKey: string;
  question: string;
  limit?: number;
  logger?: OrchestratorLogger;
}

export async function retrieveAtomsForQuestion(
  opts: RetrieveOptions,
): Promise<RetrievedAtom[]> {
  const limit = opts.limit ?? 8;
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
        score: 1 - Number(r.distance ?? 1),
        retrievalMode: "vector",
      }));
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
