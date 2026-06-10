/**
 * Jurisdiction-agnostic web-search code retrieval (ADR-019 interim grounding).
 *
 * Fetches allowlisted sources for review-scoped gaps. v2 persists reasoning
 * atoms (capped snippet + deeplinks) via reasoningAtoms/ — NOT full verbatim
 * section text and NOT public code_atoms catalog rows.
 */

import { buildDriverUrls } from "./drivers";
import { verifyAndExtract } from "./extract";
import {
  MIAMI_WHOLE_REVIEW_WEB_TARGETS,
  reviewWebTargetsForJurisdiction,
} from "./reviewTargets";
import type {
  HttpFetcher,
  WebCodeFetchInput,
  WebCodeFetchResult,
  WebCodeReviewTarget,
} from "./types";
import {
  WEBSEARCH_ATOM_PREFIX,
  WEB_CODE_ALLOWLIST_HOSTS,
} from "./types";

export {
  WEBSEARCH_ATOM_PREFIX,
  WEB_CODE_ALLOWLIST_HOSTS,
  MIAMI_WHOLE_REVIEW_WEB_TARGETS,
  reviewWebTargetsForJurisdiction,
};
export type {
  WebCodeFetchInput,
  WebCodeFetchResult,
  WebCodeReviewTarget,
  HttpFetcher,
} from "./types";

const defaultHttp: HttpFetcher = async (url) => {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const allowed = WEB_CODE_ALLOWLIST_HOSTS.some((h) => {
    const norm = h.replace(/^www\./, "");
    return host === norm || host.endsWith(`.${norm}`) || host.includes(norm);
  });
  if (!allowed) {
    throw new Error(`web_code_fetch: host not on allowlist: ${host}`);
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "Hauska-Cortex-WebCodeFetch/1.0" },
    signal: AbortSignal.timeout(25_000),
  });
  const body = await res.text();
  return { status: res.status, body, finalUrl: res.url };
};

/** Synthetic atom id for web-sourced sections (distinct from corpus UUIDs). */
export function websearchAtomId(editionSlug: string, codeRef: string): string {
  const sec = codeRef
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${WEBSEARCH_ATOM_PREFIX}${editionSlug}:${sec}`;
}

export async function fetchCodeSection(
  input: WebCodeFetchInput,
  opts: { http?: HttpFetcher; target?: WebCodeReviewTarget } = {},
): Promise<WebCodeFetchResult> {
  const http = opts.http ?? defaultHttp;
  const target: WebCodeReviewTarget =
    opts.target ?? {
      codeRef: input.codeRef,
      edition: input.edition,
      editionSlug: input.edition
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, ""),
      label: input.codeRef,
      jurisdictionKey: input.jurisdictionKey,
      drivers: input.codeRef.startsWith("NEC")
        ? ["nfpa", "upcodes"]
        : ["icc", "upcodes", "florida"],
    };

  const candidates = buildDriverUrls(target);
  const retrievedAt = new Date().toISOString();

  for (const { driver, url } of candidates) {
    try {
      const res = await http(url);
      if (res.status < 200 || res.status >= 400) continue;
      const extracted = verifyAndExtract(res.body, input);
      return {
        text: extracted.text,
        sourceUrl: res.finalUrl,
        retrievedAt,
        edition: input.edition,
        section: input.codeRef,
        confidence: extracted.confidence,
        verified: extracted.verified,
        sourceName: driver,
        ...(extracted.unverifiedWebSource
          ? { unverifiedWebSource: true }
          : {}),
      };
    } catch {
      /* try next driver */
    }
  }

  return {
    text: "",
    sourceUrl: candidates[0]?.url ?? "",
    retrievedAt,
    edition: input.edition,
    section: input.codeRef,
    confidence: 0.1,
    verified: false,
    sourceName: "none",
    unverifiedWebSource: true,
  };
}

export interface WebCodeSectionSourceLink {
  url: string;
  sourceName: string;
  edition: string;
  retrievedAt: string;
  verified: boolean;
}

export interface WebCodeSectionInput {
  atomId: string;
  label: string;
  snippet?: string;
  webProvenance: {
    sourceUrl: string;
    sources?: WebCodeSectionSourceLink[];
    retrievedAt: string;
    edition: string;
    verified: boolean;
    confidence: number;
    sourceName: string;
    verificationState?: "verified" | "unverified-web-source";
    displayMode?: "deeplink" | "licensed";
    unverifiedWebSource?: boolean;
  };
}

export function webFetchResultToSectionInput(
  result: WebCodeFetchResult,
  target: WebCodeReviewTarget,
): WebCodeSectionInput {
  return {
    atomId: websearchAtomId(target.editionSlug, target.codeRef),
    label: `${target.label} [web ${result.edition}]`,
    snippet: result.verified
      ? result.text
      : `[unverified-web-source] ${result.text || "Section text could not be verified."} Deep link: ${result.sourceUrl}`,
    webProvenance: {
      sourceUrl: result.sourceUrl,
      retrievedAt: result.retrievedAt,
      edition: result.edition,
      verified: result.verified,
      confidence: result.confidence,
      sourceName: result.sourceName,
      ...(result.unverifiedWebSource ? { unverifiedWebSource: true } : {}),
    },
  };
}

/** True when corpus already has a section matching this target (corpus wins). */
export function corpusCoversTarget(
  corpusLabels: ReadonlyArray<string>,
  target: WebCodeReviewTarget,
): boolean {
  const needle = target.codeRef.toLowerCase().replace(/\s+/g, "");
  return corpusLabels.some((label) => {
    const norm = label.toLowerCase().replace(/\s+/g, "");
    return norm.includes(needle) || norm.includes(target.label.toLowerCase().slice(0, 12));
  });
}

