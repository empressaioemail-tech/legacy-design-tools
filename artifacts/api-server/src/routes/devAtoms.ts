/**
 * /api/dev/atoms/* — operator-facing diagnostic surface for atom retrieval.
 *
 * Phase 3a: POST /dev/atoms/retrieve — the "retrieval probe". Mirrors what
 * /api/chat does at retrieval time, exposing the result so an operator can
 * answer "for query X against engagement Y, what does the LLM actually see?"
 *
 * Locked invariants:
 *   - Use the SAME modules /api/chat uses: keyFromEngagement,
 *     retrieveAtomsForQuestion, formatReferenceCodeAtoms — all from
 *     @workspace/codes. Do NOT reimplement.
 *   - Return ALL retrieved atoms (no threshold filter); the UI renders the
 *     0.6 threshold line visually.
 *   - Header-gated by x-snapshot-secret to match POST /snapshots and
 *     POST /engagements/match.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db, engagements } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  formatReferenceCodeAtoms,
  isEmbeddingAvailable,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  type RetrievedAtom,
} from "@workspace/codes";
import {
  RetrieveAtomsProbeBody,
  RetrieveAtomsProbeHeader,
} from "@workspace/api-zod";
import { getSnapshotSecret } from "../lib/snapshotSecret";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const snapshotSecret = getSnapshotSecret();

const BODY_PREVIEW_CHARS = 120;

/**
 * Whitespace-collapsing truncate matching the operator-facing preview style
 * elsewhere in /api/codes. Uses an ellipsis character (…) so the truncation
 * is visible without misleading the operator about content length.
 */
function previewBody(s: string, max: number): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

/**
 * Vector-path scores are cosine similarities in [0, 1]; lexical-path scores
 * are integer match counts. Round vector scores to 4 decimal places so the
 * UI doesn't show jittery 14-digit floats; leave lexical (integer) scores
 * alone.
 */
function roundSimilarity(score: number, mode: string): number {
  if (mode === "vector") return Math.round(score * 10_000) / 10_000;
  return score;
}

router.post(
  "/dev/atoms/retrieve",
  async (req: Request, res: Response): Promise<void> => {
    // 1. Header check — same shape/secret as POST /snapshots, POST /match.
    const headerParse = RetrieveAtomsProbeHeader.safeParse({
      "x-snapshot-secret": req.header("x-snapshot-secret"),
    });
    if (
      !headerParse.success ||
      headerParse.data["x-snapshot-secret"] !== snapshotSecret
    ) {
      res.status(401).json({ error: "Invalid snapshot secret" });
      return;
    }

    // 2. Body validation. Generated zod schema gives us required `query`,
    //    optional engagementId/jurisdiction, optional clamped topN with
    //    default 10.
    const bodyParse = RetrieveAtomsProbeBody.safeParse(req.body);
    if (!bodyParse.success) {
      res.status(400).json({ error: "Invalid retrieval probe request" });
      return;
    }
    const { engagementId, jurisdiction, query, topN } = bodyParse.data;

    // 3. Exactly-one-of constraint between engagementId and jurisdiction.
    //    Modeled in OpenAPI as both optional + server enforces XOR; cleaner
    //    for the generated client than a oneOf body schema.
    const hasEngagement = !!engagementId;
    const hasJurisdiction = !!jurisdiction;
    if (hasEngagement === hasJurisdiction) {
      res.status(400).json({
        error: "Provide exactly one of engagementId or jurisdiction",
      });
      return;
    }

    // 4. Resolve jurisdictionKey using the SAME logic /api/chat uses.
    let jurisdictionKey: string | null = null;
    let resolvedFromEngagement = false;
    if (hasEngagement) {
      try {
        const rows = await db
          .select()
          .from(engagements)
          .where(eq(engagements.id, engagementId as string))
          .limit(1);
        const eng = rows[0];
        if (!eng) {
          res.status(404).json({ error: "Engagement not found" });
          return;
        }
        jurisdictionKey = keyFromEngagement({
          jurisdictionCity: eng.jurisdictionCity,
          jurisdictionState: eng.jurisdictionState,
          jurisdiction: eng.jurisdiction,
          address: eng.address,
        });
        if (!jurisdictionKey) {
          res.status(422).json({
            error:
              "Engagement found but jurisdiction could not be resolved from its address. Geocode the engagement first or provide a jurisdiction key directly.",
          });
          return;
        }
        resolvedFromEngagement = true;
      } catch (err) {
        logger.error(
          { err, engagementId },
          "dev/atoms/retrieve: engagement lookup failed",
        );
        res.status(500).json({ error: "Failed to load engagement" });
        return;
      }
    } else {
      jurisdictionKey = (jurisdiction as string).trim();
      if (!jurisdictionKey) {
        res.status(400).json({ error: "jurisdiction must not be empty" });
        return;
      }
    }

    // 5. Run retrieval through the SAME module /api/chat imports.
    let atoms: RetrievedAtom[] = [];
    try {
      atoms = await retrieveAtomsForQuestion({
        jurisdictionKey,
        question: query,
        limit: topN,
        logger,
      });
    } catch (err) {
      logger.error(
        { err, jurisdictionKey, query },
        "dev/atoms/retrieve: retrieval failed",
      );
      res.status(500).json({ error: "Retrieval failed" });
      return;
    }

    // 6. Shape response items. Note that lexical-fallback scores are
    //    integer match counts, not cosine similarities — the UI labels this.
    const results = atoms.map((a, i) => ({
      rank: i + 1,
      atomId: a.id,
      codeRef: a.sectionNumber ?? a.sectionTitle ?? a.codeBook,
      sectionTitle: a.sectionTitle,
      bodyPreview: previewBody(a.body, BODY_PREVIEW_CHARS),
      similarity: roundSimilarity(a.score, a.retrievalMode),
      sourceBook: a.codeBook,
      sourceUrl: a.sourceUrl ?? null,
      retrievalMode: a.retrievalMode,
    }));

    // 7. Assemble the literal <reference_code_atoms> XML using the SAME
    //    helper buildChatPrompt uses internally. Empty string when there
    //    are no atoms (matches chat behavior — no empty tags emitted).
    const assembledPromptBlock = formatReferenceCodeAtoms(atoms);

    // 8. queryEmbedding metadata. `available` is true when the env supports
    //    real embeddings AND the returned atoms came from the vector path
    //    (the lexical fallback fires when embedding fails OR when the
    //    vector path returns zero rows).
    const usedVector = atoms.some((a) => a.retrievalMode === "vector");
    const available = isEmbeddingAvailable() && (atoms.length === 0 || usedVector);

    res.status(200).json({
      resolvedJurisdiction: jurisdictionKey,
      resolvedFromEngagement,
      query,
      queryEmbedding: {
        model: EMBEDDING_MODEL,
        dimension: EMBEDDING_DIMENSIONS,
        available,
      },
      results,
      assembledPromptBlock,
    });
  },
);

export default router;
