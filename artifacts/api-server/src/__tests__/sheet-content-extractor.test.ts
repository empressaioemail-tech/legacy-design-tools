/**
 * Sheet-content extractor (Task #477).
 *
 * Coverage:
 *   - mock mode: `extractSheetContentBodyFromPng` returns null and
 *     `runSheetContentExtraction` reports skipped == targets.
 *   - injected client: returns text → row's `content_body` is patched.
 *   - injected client throws → `failed` increments and the row is left
 *     untouched (mocks the LLM, never touches the network).
 *   - clipping: a payload longer than `SHEET_CONTENT_BODY_MAX_CHARS` is
 *     truncated.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("sheet-content-extractor.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { createTestSchema, dropTestSchema } = await import(
  "@workspace/db/testing"
);
const { engagements, snapshots, sheets } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const {
  extractSheetContentBodyFromPng,
  runSheetContentExtraction,
  SHEET_CONTENT_BODY_MAX_CHARS,
} = await import("../lib/sheetContentExtractor");
const { setSheetContentLlmClient } = await import(
  "../lib/sheetContentLlmClient"
);

const TINY_PNG = Buffer.from([0]);

async function seedSheet(label: string): Promise<string> {
  const db = ctx.schema!.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name: label,
      nameLower: `${label.toLowerCase()}-${Math.random().toString(36).slice(2)}`,
      jurisdiction: "Moab, UT",
      address: "1 Extract St",
    })
    .returning({ id: engagements.id });
  const [snap] = await db
    .insert(snapshots)
    .values({
      engagementId: eng.id,
      projectName: label,
      payload: { sheets: [], rooms: [] },
    })
    .returning({ id: snapshots.id });
  const [s] = await db
    .insert(sheets)
    .values({
      snapshotId: snap.id,
      engagementId: eng.id,
      sheetNumber: "A101",
      sheetName: label,
      thumbnailPng: TINY_PNG,
      thumbnailWidth: 1,
      thumbnailHeight: 1,
      fullPng: TINY_PNG,
      fullWidth: 1,
      fullHeight: 1,
      sortOrder: 0,
    })
    .returning({ id: sheets.id });
  return s.id;
}

describe("sheetContentExtractor", () => {
  beforeAll(async () => {
    ctx.schema = await createTestSchema();
  });

  afterAll(async () => {
    setSheetContentLlmClient(null);
    if (ctx.schema) {
      await dropTestSchema(ctx.schema);
      ctx.schema = null;
    }
  });

  it("returns null in mock mode (no client wired)", async () => {
    setSheetContentLlmClient(null);
    delete process.env["SHEET_CONTENT_LLM_MODE"];
    const out = await extractSheetContentBodyFromPng(TINY_PNG);
    expect(out).toBeNull();
  });

  it("runSheetContentExtraction reports skipped when client returns null", async () => {
    setSheetContentLlmClient(null);
    const sheetId = await seedSheet("mock-skip");
    const result = await runSheetContentExtraction(
      [{ sheetId, fullPng: TINY_PNG }],
      undefined,
      ctx.schema!.db,
    );
    expect(result).toEqual({ extracted: 0, skipped: 1, failed: 0 });
    const [row] = await ctx
      .schema!.db.select({ contentBody: sheets.contentBody })
      .from(sheets)
      .where(eq(sheets.id, sheetId));
    expect(row.contentBody).toBeNull();
  });

  it("persists extracted text when the injected client returns body", async () => {
    setSheetContentLlmClient({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "GENERAL NOTES\nSEE A-301" }],
        }),
      },
    } as never);
    const sheetId = await seedSheet("anthropic-ok");
    const result = await runSheetContentExtraction(
      [{ sheetId, fullPng: TINY_PNG }],
      undefined,
      ctx.schema!.db,
    );
    expect(result).toEqual({ extracted: 1, skipped: 0, failed: 0 });
    const [row] = await ctx
      .schema!.db.select({ contentBody: sheets.contentBody })
      .from(sheets)
      .where(eq(sheets.id, sheetId));
    expect(row.contentBody).toBe("GENERAL NOTES\nSEE A-301");
  });

  it("clips text longer than SHEET_CONTENT_BODY_MAX_CHARS", async () => {
    const giant = "X".repeat(SHEET_CONTENT_BODY_MAX_CHARS + 500);
    setSheetContentLlmClient({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: giant }],
        }),
      },
    } as never);
    const out = await extractSheetContentBodyFromPng(TINY_PNG);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(SHEET_CONTENT_BODY_MAX_CHARS);
  });

  it("swallows client errors and reports failed=1 (distinct from skipped)", async () => {
    setSheetContentLlmClient({
      messages: {
        create: vi.fn().mockRejectedValue(new Error("simulated outage")),
      },
    } as never);
    const sheetId = await seedSheet("anthropic-fail");
    const result = await runSheetContentExtraction(
      [{ sheetId, fullPng: TINY_PNG }],
      undefined,
      ctx.schema!.db,
    );
    expect(result).toEqual({ extracted: 0, skipped: 0, failed: 1 });
    const [row] = await ctx
      .schema!.db.select({ contentBody: sheets.contentBody })
      .from(sheets)
      .where(eq(sheets.id, sheetId));
    expect(row.contentBody).toBeNull();
  });
});
