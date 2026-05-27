/**
 * Hauska Property Brief — Chrome extension brokerage API.
 *
 *   POST /api/brokerage/v1/brief
 *   POST /api/brokerage/v1/brief/summarize
 *   POST /api/brokerage/v1/research/chat
 */

import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { geocodeAddress } from "@workspace/site-context/server";
import {
  keyFromEngagement,
  retrieveAtomsForQuestion,
  countAtomsForJurisdiction,
  type RetrievedAtom,
} from "@workspace/codes";
import { db, brokerageBriefRuns } from "@workspace/db";
import { eq } from "drizzle-orm";
import { brokerageAuth } from "../middlewares/brokerageAuth";
import { brokerageCors } from "../middlewares/brokerageCors";
import { logger } from "../lib/logger";
import {
  generateReasoningSummary,
  generateSummarize,
  generateResearchChat,
  type BriefAtomInput,
} from "../lib/brokerageBriefLlm";
import { recordGtmEvent } from "../lib/recordGtmEvent";
import { brokerageGtmRouter } from "./brokerageGtm";

/** Mirrors hauska-brief-extension/src/lib/brief-engine.js CODE_QUERIES */
export const BROKERAGE_CODE_QUERIES = [
  "accessory dwelling unit ADU requirements",
  "setback requirements residential",
  "short term rental STR",
  "swimming pool requirements",
  "major addition permit",
] as const;

const BRIEF_BODY = z.object({
  address: z.string().min(1),
  mls_id: z.string().optional(),
  source: z.string().optional(),
  page_url: z.string().optional(),
});

const SUMMARIZE_BODY = z.object({
  address: z.string().min(1),
  jurisdiction: z.string().optional(),
  corpusStatus: z.string().optional(),
  atoms: z.array(
    z.object({
      atomDid: z.string().min(1),
      snippet: z.string(),
    }),
  ),
});

const RESEARCH_CHAT_BODY = z.object({
  runId: z.string().uuid(),
  message: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
});

const router: IRouter = Router();
const brokerageV1: IRouter = Router();

brokerageV1.use(brokerageCors);
brokerageV1.use(brokerageAuth);
brokerageV1.use("/gtm", brokerageGtmRouter);

function installIdFromRequest(req: Request): string | null {
  const raw = req.headers["x-hauska-install-id"];
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length >= 8 ? id : null;
}

function listingKey(address: string, mlsId?: string | null): string {
  const norm = address.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update(`${norm}|${(mlsId ?? "").trim()}`)
    .digest("hex");
}

function sectionTitle(query: string): string {
  const first = query.split(" ")[0] ?? query;
  return first.toUpperCase() + query.slice(first.length, 40);
}

function atomSnippet(atom: RetrievedAtom): string {
  const title = atom.sectionTitle?.trim();
  const body = atom.body?.trim() ?? "";
  if (title && body) return `${title}: ${body}`.slice(0, 500);
  return (body || title || "").slice(0, 500);
}

function toBriefAtom(atom: RetrievedAtom, label?: string): BriefAtomInput {
  return {
    atomDid: atom.id,
    snippet: atomSnippet(atom),
    label,
  };
}

async function resolveCorpusStatus(
  jurisdictionKey: string | null,
  hasHits: boolean,
): Promise<"in_corpus" | "partial" | "no_match" | "unknown"> {
  if (!jurisdictionKey) return "no_match";
  if (hasHits) return "in_corpus";
  try {
    const count = await countAtomsForJurisdiction(jurisdictionKey);
    return count > 0 ? "partial" : "no_match";
  } catch {
    return "unknown";
  }
}

async function runCodeRetrieval(
  jurisdictionKey: string,
): Promise<{
  sections: Array<{
    title: string;
    query: string;
    hits: Array<{ atomDid: string; snippet: string; score: number }>;
  }>;
  citations: Array<{ atomDid: string; query: string; snippet: string }>;
}> {
  const sections: Array<{
    title: string;
    query: string;
    hits: Array<{ atomDid: string; snippet: string; score: number }>;
  }> = [];
  const citations: Array<{ atomDid: string; query: string; snippet: string }> =
    [];

  for (const query of BROKERAGE_CODE_QUERIES) {
    let hits: RetrievedAtom[] = [];
    try {
      hits = await retrieveAtomsForQuestion({
        jurisdictionKey,
        question: query,
        limit: 2,
        logger,
      });
    } catch (err) {
      logger.warn({ err, jurisdictionKey, query }, "brokerage: retrieval failed");
    }

    if (hits.length > 0) {
      const top = hits[0]!;
      citations.push({
        atomDid: top.id,
        query,
        snippet: atomSnippet(top).slice(0, 280),
      });
    }

    sections.push({
      title: sectionTitle(query),
      query,
      hits: hits.map((h) => ({
        atomDid: h.id,
        snippet: atomSnippet(h),
        score: h.score,
      })),
    });
  }

  return { sections, citations };
}

brokerageV1.post("/brief", async (req: Request, res: Response) => {
  const parse = BRIEF_BODY.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: "invalid_request", message: "Invalid brief body" });
    return;
  }

  const { address, mls_id, source, page_url } = parse.data;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const installId = installIdFromRequest(req);
  const lk = listingKey(address, mls_id);

  if (installId) {
    recordGtmEvent({
      installId,
      eventType: "brief_started",
      runId,
      listingKey: lk,
      payload: { source: source ?? null },
    });
  }

  let geocode: {
    lat: number;
    lon: number;
    city?: string | null;
    state?: string | null;
    error?: string;
  } | null = null;

  try {
    const geo = await geocodeAddress(address);
    if (geo) {
      geocode = {
        lat: geo.latitude,
        lon: geo.longitude,
        city: geo.jurisdictionCity,
        state: geo.jurisdictionState,
      };
    }
  } catch (err) {
    geocode = { lat: 0, lon: 0, error: String((err as Error).message || err) };
  }

  const jurisdictionKey = keyFromEngagement({
    jurisdictionCity: geocode?.city ?? null,
    jurisdictionState: geocode?.state ?? null,
    address,
  });

  let sections: Array<{
    title: string;
    query: string;
    hits: Array<{ atomDid: string; snippet: string; score: number }>;
  }> = [];
  let citations: Array<{ atomDid: string; query: string; snippet: string }> = [];

  if (!jurisdictionKey) {
    sections = [
      {
        title: "Municipal code",
        query: "jurisdiction",
        hits: [],
      },
    ];
  } else {
    const retrieved = await runCodeRetrieval(jurisdictionKey);
    sections = retrieved.sections;
    citations = retrieved.citations;
  }

  const hasHits = sections.some((s) => s.hits.length > 0);
  const corpusStatus = await resolveCorpusStatus(jurisdictionKey, hasHits);
  const finishedAt = new Date().toISOString();

  const briefAtoms: BriefAtomInput[] = [];
  for (const s of sections) {
    const top = s.hits[0];
    if (top) {
      briefAtoms.push({
        atomDid: top.atomDid,
        snippet: top.snippet,
        label: sectionTitle(s.query),
      });
    }
  }

  const reasoningSummary = await generateReasoningSummary({
    address,
    jurisdiction: jurisdictionKey,
    corpusStatus,
    atoms: briefAtoms,
    finishedAt,
  });

  const responseBody = {
    runId,
    startedAt,
    finishedAt,
    property: {
      address,
      source: source ?? null,
      url: page_url ?? null,
    },
    jurisdiction: jurisdictionKey,
    corpusStatus,
    geocode: geocode
      ? { lat: geocode.lat, lon: geocode.lon }
      : undefined,
    sections,
    citations,
    reasoningSummary,
    meta: {
      disclaimer:
        "Not legal advice. Code layer only where jurisdiction is in corpus. Verify with city staff.",
      tool: "brokerage-brief-v1",
    },
  };

  await db.insert(brokerageBriefRuns).values({
    id: runId,
    tenantSlug: "default",
    listingKey: lk,
    address,
    payloadJson: responseBody,
  });

  if (installId) {
    recordGtmEvent({
      installId,
      eventType: "brief_completed",
      runId,
      listingKey: lk,
      payload: {
        corpusStatus,
        jurisdiction: jurisdictionKey,
        citationCount: citations.length,
      },
    });
  }

  res.json(responseBody);
});

brokerageV1.post(
  "/brief/summarize",
  async (req: Request, res: Response) => {
    const parse = SUMMARIZE_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid summarize body",
      });
      return;
    }

    const { address, jurisdiction, corpusStatus, atoms } = parse.data;
    const result = await generateSummarize({
      address,
      jurisdiction: jurisdiction ?? null,
      corpusStatus: corpusStatus ?? "unknown",
      atoms: atoms.map((a, i) => ({
        atomDid: a.atomDid,
        snippet: a.snippet,
        label: `Source ${i + 1}`,
      })),
    });

    res.json(result);
  },
);

brokerageV1.post(
  "/research/chat",
  async (req: Request, res: Response) => {
    const parse = RESEARCH_CHAT_BODY.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_request",
        message: "Invalid research chat body",
      });
      return;
    }

    const { runId, message, history } = parse.data;

    const [run] = await db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.id, runId))
      .limit(1);

    if (!run) {
      res.status(404).json({ error: "not_found", message: "Brief run not found" });
      return;
    }

    const payload = run.payloadJson as {
      jurisdiction?: string | null;
      property?: { address?: string };
      citations?: Array<{ atomDid: string; snippet?: string; query?: string }>;
      sections?: Array<{
        hits?: Array<{ atomDid: string; snippet: string }>;
      }>;
    };

    const jurisdictionKey = payload.jurisdiction ?? null;
    const address = payload.property?.address ?? run.address;

    const atomMap = new Map<string, BriefAtomInput>();

    for (const c of payload.citations ?? []) {
      if (c.atomDid && !atomMap.has(c.atomDid)) {
        atomMap.set(c.atomDid, {
          atomDid: c.atomDid,
          snippet: c.snippet ?? "",
          label: c.query?.slice(0, 40) ?? "Prior brief",
        });
      }
    }
    for (const sec of payload.sections ?? []) {
      for (const h of sec.hits ?? []) {
        if (h.atomDid && !atomMap.has(h.atomDid)) {
          atomMap.set(h.atomDid, {
            atomDid: h.atomDid,
            snippet: h.snippet,
          });
        }
      }
    }

    if (jurisdictionKey) {
      try {
        const retrieved = await retrieveAtomsForQuestion({
          jurisdictionKey,
          question: message,
          limit: 8,
          logger,
        });
        for (const a of retrieved) {
          if (!atomMap.has(a.id)) {
            atomMap.set(a.id, toBriefAtom(a, "Research retrieval"));
          }
        }
      } catch (err) {
        logger.warn(
          { err, runId, jurisdictionKey },
          "brokerage: research chat retrieval failed",
        );
      }
    }

    const atoms = [...atomMap.values()];
    const result = await generateResearchChat({
      address,
      jurisdiction: jurisdictionKey,
      message,
      history,
      atoms,
    });

    const installId = installIdFromRequest(req);
    if (installId) {
      recordGtmEvent({
        installId,
        eventType: "research_chat_turn",
        runId,
        listingKey: run.listingKey,
        payload: { messageLength: message.length },
      });
    }

    res.json(result);
  },
);

router.use("/brokerage/v1", brokerageV1);

export default router;
