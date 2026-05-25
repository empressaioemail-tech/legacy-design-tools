/**
 * QA-55 — AI product-spec recommendation batch for an engagement.
 *
 * Reads sheets, existing L5 references, and recent findings, then
 * returns draft ICC-ES rows for operator review (not persisted).
 */

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  engagements,
  findings,
  productSpecReferences,
  sheets,
  submissions,
} from "@workspace/db";
import { logger } from "./logger";
import {
  getProductSpecRecommendationsLlmClient,
  getProductSpecRecommendationsLlmMode,
  type ProductSpecRecommendationsLlmMode,
} from "./productSpecRecommendationsLlmClient";
import {
  parseProductSpecRecommendationsJson,
  type ProductSpecRecommendation,
} from "./productSpecRecommendations.logic";

const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_MAX_TOKENS = 2500;

interface AnthropicLikeClient {
  messages: {
    create: (args: unknown) => Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
    }>;
  };
}

export interface GenerateProductSpecRecommendationsResult {
  mode: ProductSpecRecommendationsLlmMode;
  recommendations: ProductSpecRecommendation[];
}

interface EngagementContext {
  name: string;
  address: string | null;
  sheets: Array<{
    sheetNumber: string;
    sheetName: string;
    contentExcerpt: string | null;
  }>;
  existingReferences: Array<{
    name: string;
    manufacturer: string;
    esrNumber: string;
  }>;
  findings: Array<{
    severity: string;
    category: string;
    text: string;
  }>;
}

async function loadEngagementContext(
  engagementId: string,
): Promise<EngagementContext | null> {
  const engRows = await db
    .select({
      name: engagements.name,
      address: engagements.address,
    })
    .from(engagements)
    .where(eq(engagements.id, engagementId))
    .limit(1);
  const eng = engRows[0];
  if (!eng) return null;

  const sheetRows = await db
    .select({
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      contentBody: sheets.contentBody,
    })
    .from(sheets)
    .where(eq(sheets.engagementId, engagementId))
    .orderBy(desc(sheets.sortOrder))
    .limit(40);

  const refRows = await db
    .select({
      productName: productSpecReferences.productName,
      productManufacturer: productSpecReferences.productManufacturer,
      esrNumber: productSpecReferences.esrNumber,
    })
    .from(productSpecReferences)
    .where(eq(productSpecReferences.engagementId, engagementId))
    .orderBy(desc(productSpecReferences.createdAt))
    .limit(50);

  const subRows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.engagementId, engagementId))
    .orderBy(desc(submissions.createdAt))
    .limit(1);

  let findingRows: EngagementContext["findings"] = [];
  const latestSub = subRows[0];
  if (latestSub) {
    const rows = await db
      .select({
        severity: findings.severity,
        category: findings.category,
        text: findings.text,
      })
      .from(findings)
      .where(eq(findings.submissionId, latestSub.id))
      .limit(25);
    findingRows = rows.map((r) => ({
      severity: r.severity,
      category: r.category,
      text: r.text.slice(0, 400),
    }));
  }

  return {
    name: eng.name,
    address: eng.address,
    sheets: sheetRows.map((s) => ({
      sheetNumber: s.sheetNumber,
      sheetName: s.sheetName,
      contentExcerpt: s.contentBody
        ? s.contentBody.slice(0, 1200)
        : null,
    })),
    existingReferences: refRows.map((r) => ({
      name: r.productName,
      manufacturer: r.productManufacturer,
      esrNumber: r.esrNumber,
    })),
    findings: findingRows,
  };
}

function mockRecommendations(ctx: EngagementContext): ProductSpecRecommendation[] {
  const base: ProductSpecRecommendation[] = [
    {
      product: {
        name: "ZIP System R-sheathing",
        manufacturer: "Huber Engineered Woods",
      },
      esrNumber: "ESR-1474",
      reasoning:
        "Common wall sheathing with integrated WRB for wood-frame residential; cite on exterior wall schedules.",
      sheetHint: "A-series wall sections",
    },
    {
      product: {
        name: "Strong-Drive SDWS Timber Screw",
        manufacturer: "Simpson Strong-Tie",
      },
      esrNumber: "ESR-3046",
      reasoning:
        "Structural wood screw for shear walls and diaphragms; typical on connector schedules.",
      sheetHint: "S-series structural notes",
    },
    {
      product: {
        name: "TJI 230 Joist",
        manufacturer: "Weyerhaeuser",
      },
      esrNumber: "ESR-1153",
      reasoning:
        "Engineered floor framing for residential spans; align with floor framing plans.",
      sheetHint: "S-101 framing plan",
    },
    {
      product: {
        name: "DensGlass Gold Sheathing",
        manufacturer: "Georgia-Pacific",
      },
      esrNumber: "ESR-2383",
      reasoning:
        "Exterior gypsum sheathing behind masonry or cladding; check wall type callouts.",
      sheetHint: "A-301 wall types",
    },
    {
      product: {
        name: "Tyvek HomeWrap",
        manufacturer: "DuPont",
      },
      esrNumber: "ESR-2375",
      reasoning:
        "Weather-resistive barrier on wood-frame walls when not using integrated sheathing.",
      sheetHint: "General notes",
    },
  ];
  const existing = new Set(
    ctx.existingReferences.map((r) => r.esrNumber.toUpperCase()),
  );
  return base.filter((r) => !existing.has(r.esrNumber.toUpperCase()));
}

function buildUserPrompt(ctx: EngagementContext): string {
  return [
    "Engagement:",
    JSON.stringify(
      {
        name: ctx.name,
        address: ctx.address,
        sheetCount: ctx.sheets.length,
        sheets: ctx.sheets,
        existingProductSpecReferences: ctx.existingReferences,
        recentFindings: ctx.findings,
      },
      null,
      2,
    ),
    "",
    "Return a JSON array (no markdown fences) of 3–8 ICC-ES product-spec recommendations.",
    "Each element must have:",
    '  product: { name: string, manufacturer: string }',
    '  esrNumber: string matching ESR-<digits> (realistic ICC-ES numbers only)',
    "  reasoning: one sentence for the architect",
    "  sheetHint: optional string naming which sheet/note drove the suggestion",
    "",
    "Skip products already in existingProductSpecReferences.",
    "Prefer products implied by sheet notes, structural schedules, and findings.",
    "Do not invent ESR numbers outside the ESR-#### pattern.",
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are a licensed architect's product-spec assistant for Cortex Deliver.",
  "Suggest ICC-ES evaluated building products (ESR reports) the operator should",
  "track on this engagement. Output ONLY valid JSON — a top-level array.",
].join(" ");

function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("LLM response did not contain a JSON array");
  }
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

export async function generateProductSpecRecommendations(
  engagementId: string,
): Promise<GenerateProductSpecRecommendationsResult | null> {
  const ctx = await loadEngagementContext(engagementId);
  if (!ctx) return null;

  const mode = getProductSpecRecommendationsLlmMode();
  if (mode === "mock") {
    return { mode, recommendations: mockRecommendations(ctx) };
  }

  const client = (await getProductSpecRecommendationsLlmClient()) as AnthropicLikeClient | null;
  if (!client) {
    return { mode: "mock", recommendations: mockRecommendations(ctx) };
  }

  try {
    const response = await client.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    });
    const text = response.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
    const parsed = parseProductSpecRecommendationsJson(extractJsonArray(text));
    if (parsed.length === 0) {
      logger.warn(
        { engagementId },
        "product-spec recommendations LLM returned no valid rows; using mock fallback",
      );
      return { mode, recommendations: mockRecommendations(ctx) };
    }
    return { mode, recommendations: parsed };
  } catch (err) {
    logger.error(
      { err, engagementId },
      "product-spec recommendations LLM failed; using mock fallback",
    );
    return { mode, recommendations: mockRecommendations(ctx) };
  }
}
