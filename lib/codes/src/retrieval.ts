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
  /** Source marker to distinguish ICC model code from jurisdiction-adopted code. */
  codeSource?: "icc-model-code" | "jurisdiction";
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
  /**
   * When true, supplement jurisdiction retrieval with ICC model-code corpus.
   * Defaults to the value of FINDINGS_ICC_MODEL_CODE_SUPPLEMENT env var.
   * The supplement runs via substrate retrieval and degrades gracefully when
   * BRIEF_RETRIEVAL_API_URL is unset or the call fails.
   */
  includeIccModelCodeSupplement?: boolean;
}

export async function retrieveAtomsForQuestion(
  opts: RetrieveOptions,
): Promise<RetrievedAtom[]> {
  const mode = (process.env.BRIEF_CODE_RETRIEVAL ?? "neon").toLowerCase();
  let primaryAtoms: RetrievedAtom[] = [];
  
  if (mode === "gate" || mode === "mcp") {
    const { retrieveAtomsFromSubstrate } = await import(
      "./briefRetrievalSubstrate.js"
    );
    try {
      const substrateHits = await retrieveAtomsFromSubstrate(opts);
      if (substrateHits.length > 0) {
        primaryAtoms = substrateHits;
      } else {
        opts.logger?.warn?.(
          { jurisdictionKey: opts.jurisdictionKey, mode },
          "substrate retrieval returned no hits — falling back to neon",
        );
        primaryAtoms = await retrieveAtomsFromNeon(opts);
      }
    } catch (err) {
      opts.logger?.warn?.(
        { err, jurisdictionKey: opts.jurisdictionKey, mode },
        "substrate retrieval failed — falling back to neon",
      );
      primaryAtoms = await retrieveAtomsFromNeon(opts);
    }
  } else {
    primaryAtoms = await retrieveAtomsFromNeon(opts);
  }

  // Tag primary atoms as jurisdiction-sourced
  primaryAtoms.forEach((atom) => {
    atom.codeSource = "jurisdiction";
  });

  // Supplement with ICC model code if enabled
  const supplementEnabled = 
    opts.includeIccModelCodeSupplement ??
    (process.env.FINDINGS_ICC_MODEL_CODE_SUPPLEMENT ?? "true").toLowerCase() === "true";
  
  if (supplementEnabled && process.env.BRIEF_RETRIEVAL_API_URL) {
    const supplementAtoms = await retrieveIccModelCodeSupplement(opts);
    return [...primaryAtoms, ...supplementAtoms];
  }

  return primaryAtoms;
}

async function retrieveAtomsFromNeon(
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
 * Supplement jurisdiction retrieval with ICC model-code corpus atoms.
 * 
 * Runs a secondary substrate call to `jurisdictionKey='icc-model-code'` and
 * tags results with `codeSource='icc-model-code'` for honest labeling.
 * Degrades gracefully (logs + returns []) when substrate is unavailable.
 * 
 * The supplement is capped at 6 atoms to augment rather than swamp
 * jurisdiction-specific sections.
 */
async function retrieveIccModelCodeSupplement(
  opts: RetrieveOptions,
): Promise<RetrievedAtom[]> {
  const { retrieveAtomsFromSubstrate } = await import(
    "./briefRetrievalSubstrate.js"
  );
  
  const supplementLimit = 6;
  
  try {
    const iccAtoms = await retrieveAtomsFromSubstrate({
      jurisdictionKey: "icc-model-code",
      question: opts.question,
      limit: supplementLimit,
      logger: opts.logger,
    });
    
    iccAtoms.forEach((atom) => {
      atom.codeSource = "icc-model-code";
    });
    
    if (iccAtoms.length > 0) {
      opts.logger?.info?.(
        { count: iccAtoms.length },
        "ICC model-code supplement: retrieved atoms",
      );
    }
    
    return iccAtoms;
  } catch (err) {
    opts.logger?.warn?.(
      { err },
      "ICC model-code supplement: retrieval failed — skipping supplement",
    );
    return [];
  }
}

/**
 * Count the code atoms ingested for a jurisdiction, independent of any
 * question. The chat route's honesty guardrail (QA-23) uses this to tell
 * "this jurisdiction has grounded code coverage" apart from "a specific
 * question retrieved nothing this turn": a zero count means the agent must
 * flag any code answer as model-knowledge-only rather than presenting a
 * fabricated section number as a grounded citation.
 */
export async function countAtomsForJurisdiction(
  jurisdictionKey: string,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(codeAtoms)
    .where(eq(codeAtoms.jurisdictionKey, jurisdictionKey));
  return Number(rows[0]?.n ?? 0);
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
