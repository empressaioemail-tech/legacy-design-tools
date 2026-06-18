import { randomUUID } from "node:crypto";
import {
  fetchCodeSection,
  reasoningAtomId,
  retrieveReasoningAtomById,
  upsertReasoningAtomCorpusOverlay,
  upsertReasoningAtomDeeplinkOnly,
  upsertReasoningAtomFromWebFetch,
  type HttpFetcher,
} from "@workspace/codes";
import { parseCodewarmManifest } from "./manifest";
import { queryCorpusCoverage } from "./corpusCoverage";
import { createCostTracker, DEFAULT_COST_PER_FETCH_USD } from "./costRecord";
import { manifestEntryToTarget, nfpaDeeplinkUrl } from "./targets";
import type {
  CodewarmBatchOptions,
  CodewarmBatchResult,
  CodewarmReferenceResult,
} from "./types";

/**
 * Cold-warm batch harness — warms manifest references into reasoning atoms.
 * Corpus-aware (corpus > reasoning > web). No findings. No verbatim body.
 */
export async function runCodewarmBatch(
  options: CodewarmBatchOptions,
): Promise<CodewarmBatchResult> {
  const entries = parseCodewarmManifest(options.manifestPath);
  const dryRun = options.dryRun ?? false;
  const costPerFetch = options.costPerFetchUsd ?? DEFAULT_COST_PER_FETCH_USD;
  const cost = createCostTracker({ budgetCapUsd: options.budgetCapUsd });
  const log = options.log ?? (() => undefined);

  const results: CodewarmReferenceResult[] = [];
  let corpusCoveredCount = 0;
  let corpusSkippedCount = 0;
  let warmedCount = 0;
  let deeplinkOnlyCount = 0;
  let verifiedSkippedCount = 0;
  let unverifiedSkippedCount = 0;
  let errorCount = 0;

  const http = wrapHttpWithCost(options.http, cost, costPerFetch);

  for (const entry of entries) {
    if (cost.haltedByBudget) {
      results.push({
        codeRef: entry.codeRef,
        edition: entry.edition,
        outcome: "budget-halted",
      });
      continue;
    }

    try {
      const target = manifestEntryToTarget(entry, options.jurisdictionKey);

      if (entry.grounding === "NFPA-license-required") {
        if (dryRun) {
          results.push({
            codeRef: entry.codeRef,
            edition: entry.edition,
            outcome: "dry-run",
          });
          continue;
        }
        const atom = await upsertReasoningAtomDeeplinkOnly({
          jurisdictionKey: options.jurisdictionKey,
          target,
          deeplinkUrl: nfpaDeeplinkUrl(entry),
        });
        deeplinkOnlyCount++;
        results.push({
          codeRef: entry.codeRef,
          edition: entry.edition,
          outcome: "deeplink-only",
          atomId: atom.id,
          verificationState: atom.verificationState,
          assertedConfidence: atom.assertedConfidence,
        });
        log("codewarm deeplink-only (NFPA-license-required)", {
          codeRef: entry.codeRef,
        });
        continue;
      }

      const coverage = await queryCorpusCoverage({
        jurisdictionKey: options.jurisdictionKey,
        entry,
      });

      if (coverage.covered) {
        if (entry.grounding === "verify-existing-corpus") {
          corpusSkippedCount++;
          results.push({
            codeRef: entry.codeRef,
            edition: entry.edition,
            outcome: "corpus-skipped",
            atomId: coverage.corpusAtomId,
          });
          log("codewarm corpus-skipped (verify-existing-corpus)", {
            codeRef: entry.codeRef,
            corpusAtomId: coverage.corpusAtomId,
          });
          continue;
        }

        if (dryRun) {
          corpusCoveredCount++;
          results.push({
            codeRef: entry.codeRef,
            edition: entry.edition,
            outcome: "dry-run",
          });
          continue;
        }

        const atom = await upsertReasoningAtomCorpusOverlay({
          jurisdictionKey: options.jurisdictionKey,
          target,
          corpusSourceUrl: coverage.corpusSourceUrl!,
          corpusAtomId: coverage.corpusAtomId!,
        });
        corpusCoveredCount++;
        results.push({
          codeRef: entry.codeRef,
          edition: entry.edition,
          outcome: "corpus-covered",
          atomId: atom.id,
          verificationState: atom.verificationState,
          assertedConfidence: atom.assertedConfidence,
        });
        log("codewarm corpus-covered overlay", {
          codeRef: entry.codeRef,
          corpusAtomId: coverage.corpusAtomId,
        });
        continue;
      }

      if (dryRun) {
        const atomId = reasoningAtomId(target.editionSlug, target.codeRef);
        if (options.incrementalDeepen) {
          const existing = await retrieveReasoningAtomById(atomId);
          if (existing?.verificationState === "verified") {
            verifiedSkippedCount++;
            results.push({
              codeRef: entry.codeRef,
              edition: entry.edition,
              outcome: "verified-skipped",
              atomId: existing.id,
              verificationState: existing.verificationState,
            });
            log("codewarm verified-skipped (incremental deepen)", {
              codeRef: entry.codeRef,
              atomId: existing.id,
            });
            continue;
          }
        }

        const result = await fetchCodeSection(
          {
            codeRef: entry.codeRef,
            edition: target.edition,
            jurisdictionKey: options.jurisdictionKey,
            expectedTitle: entry.title,
          },
          { http, target },
        );
        warmedCount++;
        results.push({
          codeRef: entry.codeRef,
          edition: entry.edition,
          outcome: "dry-run",
          verificationState: result.verified ? "verified" : "unverified-web-source",
          assertedConfidence: result.verified
            ? result.confidence
            : Math.min(result.confidence, 0.35),
        });
        continue;
      }

      const atomId = reasoningAtomId(target.editionSlug, target.codeRef);
      if (options.incrementalDeepen) {
        const existing = await retrieveReasoningAtomById(atomId);
        if (existing?.verificationState === "verified") {
          verifiedSkippedCount++;
          results.push({
            codeRef: entry.codeRef,
            edition: entry.edition,
            outcome: "verified-skipped",
            atomId: existing.id,
            verificationState: existing.verificationState,
          });
          log("codewarm verified-skipped (incremental deepen)", {
            codeRef: entry.codeRef,
            atomId: existing.id,
          });
          continue;
        }
      }

      const result = await fetchCodeSection(
        {
          codeRef: entry.codeRef,
          edition: target.edition,
          jurisdictionKey: options.jurisdictionKey,
          expectedTitle: entry.title,
        },
        { http, target },
      );

      const atom = await upsertReasoningAtomFromWebFetch({
        jurisdictionKey: options.jurisdictionKey,
        target,
        result,
        verifyBeforePromote: Boolean(options.incrementalDeepen),
      });
      if (
        options.incrementalDeepen &&
        !result.verified &&
        atom.verificationState !== "verified"
      ) {
        unverifiedSkippedCount++;
        results.push({
          codeRef: entry.codeRef,
          edition: entry.edition,
          outcome: "unverified-skipped",
          atomId: atom.id,
          verificationState: atom.verificationState,
        });
        log("codewarm unverified-skipped (verify-before-promote)", {
          codeRef: entry.codeRef,
          atomId: atom.id,
        });
        continue;
      }
      warmedCount++;
      results.push({
        codeRef: entry.codeRef,
        edition: entry.edition,
        outcome: "warmed",
        atomId: atom.id,
        verificationState: atom.verificationState,
        assertedConfidence: atom.assertedConfidence,
      });
      log("codewarm warmed", {
        codeRef: entry.codeRef,
        verified: result.verified,
        atomId: atom.id,
      });
    } catch (err) {
      errorCount++;
      results.push({
        codeRef: entry.codeRef,
        edition: entry.edition,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      log("codewarm error", {
        codeRef: entry.codeRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (cost.haltedByBudget) break;
  }

  const split = {
    corpusCoveredCount,
    corpusSkippedCount,
    warmedCount,
    deeplinkOnlyCount,
    verifiedSkippedCount,
    unverifiedSkippedCount,
    errorCount,
    dryRun,
  };
  log("codewarm batch split", split);

  return {
    batchId: cost.batchId,
    manifestPath: options.manifestPath,
    jurisdictionKey: options.jurisdictionKey,
    dryRun,
    corpusCoveredCount,
    corpusSkippedCount,
    warmedCount,
    deeplinkOnlyCount,
    verifiedSkippedCount,
    unverifiedSkippedCount,
    errorCount,
    results,
    costRecord: cost.toRecord({
      manifestPath: options.manifestPath,
      jurisdictionKey: options.jurisdictionKey,
    }),
  };
}

function codewarmHttpTimeoutMs(): number {
  const raw = process.env.CODEWARM_HTTP_TIMEOUT_MS?.trim();
  const n = raw ? Number.parseInt(raw, 10) : 25_000;
  return Number.isFinite(n) && n > 0 ? n : 25_000;
}

function wrapHttpWithCost(
  http: HttpFetcher | undefined,
  cost: ReturnType<typeof createCostTracker>,
  costPerFetch: number,
): HttpFetcher {
  const timeoutMs = codewarmHttpTimeoutMs();
  return async (url) => {
    cost.chargeFetch(costPerFetch);
    if (http) return http(url);
    const res = await fetch(url, {
      headers: { "User-Agent": "Hauska-Codewarm-Batch/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    return { status: res.status, body, finalUrl: res.url };
  };
}

export { reasoningAtomId, randomUUID };
