/**
 * WS-C — in-app Cortex agent tool surface.
 *
 * The in-app chat route (`chat.ts`) runs an Anthropic tool-use loop. This
 * module owns everything the loop needs that is NOT the loop itself:
 *
 *   - `CHAT_AGENT_TOOLS`      — the Anthropic tool definitions.
 *   - `executeAgentTool`      — the in-process dispatcher + handlers.
 *   - provenance constants    — the AI-origin marker (WSC.5).
 *   - `buildAgentToolGuidance`— the system-prompt augmentation.
 *
 * Design constraints (per the WS-C dispatch):
 *   - Tools run IN-PROCESS against cortex-api's own tables — never via the
 *     hauska-mcp-server. They reuse the L-surface contract (the same
 *     `responseTasks` table + validation + `atom_events` audit chain the
 *     Lane C.4 routes write), so an agent-created task is byte-identical
 *     to an operator-created one and readable by `GET /response-tasks`.
 *   - Every tool is scoped to ONE engagement, bound from `ToolContext`.
 *     `engagementId` is never a tool input, so the model cannot reach
 *     another tenant's data.
 *   - L4 / L5 specs are DRAFT-ONLY: the agent prepares a form-valid draft
 *     and the operator persists it through the existing manual form. The
 *     agent never directly writes a detail-callout-spec or
 *     product-spec-reference atom — those endpoints have no reversible
 *     (delete/archive) path, so a direct agent-write would violate the
 *     WSC.5 reversibility guardrail.
 *   - The one direct agent-write — `create_response_tasks` — is reversible
 *     (L1 `cancelled` state) and carries provenance + an AI-origin marker.
 */

import type { Request } from "express";
import {
  db,
  engagements,
  snapshots,
  sheets,
  submissions,
  findings,
  responseTasks,
  detailCalloutSpecs,
  productSpecReferences,
  parcelBriefings,
  briefingSources,
  sheetContentExtractions,
  attachedDocuments,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import type { Scope } from "@hauska/atom-contract";
import {
  DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA,
  ESR_NUMBER_RE,
} from "@workspace/atoms-l-surface";
import { logger } from "../lib/logger";
import { recordLSurfaceEvent } from "../lib/lSurfaceRoute";
import { parseCreateResponseTaskBody } from "./responseTasks.logic";

/* -------------------------------------------------------------------------- */
/*  Provenance (WSC.5)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `actorId` stamped onto every atom the in-app agent creates. This is the
 * explicit AI-origin marker the WSC.5 guardrail requires — it distinguishes
 * an agent-created response-task from an operator-created one on the atom
 * itself, and the FE renders an "AI-drafted" badge off it.
 */
export const AI_AGENT_ACTOR_ID = "cortex-in-app-agent";

/**
 * `principalActorId` fallback for an agent write. The agent acts on behalf
 * of the operator; in production the session is the fail-closed anonymous
 * applicant and carries no requestor id, so this constant stands in.
 */
export const AI_AGENT_PRINCIPAL_FALLBACK = "cortex-operator";

/** Hard cap on a single tool result so a degenerate row set cannot blow the prompt. */
const MAX_TOOL_RESULT_CHARS = 12_000;

/** Hard cap on rows returned by a `list_*` tool. */
const MAX_LIST_ROWS = 100;

/** Max response-tasks a single `create_response_tasks` call may create. */
const MAX_TASKS_PER_CALL = 25;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** Per-request context every tool handler is bound to. */
export interface ToolContext {
  /** The one engagement every tool in this turn may touch. */
  engagementId: string;
  /** Request-scoped audience/permission scope (forwarded from the session). */
  scope: Scope;
  /** The originating Express request — source of session requestor id. */
  req: Request;
  /** Request-scoped logger. */
  reqLog: typeof logger;
}

/**
 * A write the agent performed this turn. Streamed to the panel as an
 * `agent_action` SSE event and accumulated into the session agent-action
 * log (WSC.5). `reverseHint` tells the FE how to undo it.
 */
export interface AgentAction {
  kind: "response-task-created";
  entityType: "response-task";
  entityId: string;
  engagementId: string;
  /** Human label for the action-log row (the task title). */
  label: string;
  reversible: true;
  /** `cancel` → FE POSTs `/response-tasks/:id/state` with `cancelled`. */
  reverseHint: "cancel";
}

/**
 * A spec draft the agent prepared. Streamed as an `agent_draft` SSE event;
 * the FE opens the matching L4 / L5 manual form pre-filled (WSC.4). Nothing
 * is persisted until the operator submits that form.
 */
export interface AgentDraft {
  draftKind: "detail-callout-spec" | "product-spec-reference";
  engagementId: string;
  /** Validated draft payload the form pre-fills from. */
  payload: Record<string, unknown>;
  /** The agent's one-line rationale, shown in the form banner. */
  reasoning: string;
}

/** Side-effect a tool produced, surfaced to the FE over SSE. */
export type AgentSideEffect =
  | { type: "agent_action"; action: AgentAction }
  | { type: "agent_draft"; draft: AgentDraft };

/** Result of running one tool. */
export interface ToolRunResult {
  /** Text handed back to the model as the `tool_result` content. */
  resultText: string;
  /** True → the route marks the `tool_result` `is_error`. */
  isError?: boolean;
  /** Write/draft side-effects for the FE. */
  events?: AgentSideEffect[];
}

/** Minimal structural Anthropic tool-definition shape. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function truncate(s: string, max = MAX_TOOL_RESULT_CHARS): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** JSON-stringify a tool result, pretty + truncated. */
function asJson(value: unknown): string {
  return truncate(JSON.stringify(value, null, 2));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function optionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Resolve the operator (`principalActorId`) for an agent write. The agent
 * acts on the operator's behalf, so the agent itself is the `actorId`
 * marker and the operator is the principal.
 */
function resolvePrincipalActorId(req: Request): string {
  const requestor = req.session?.requestor;
  return requestor && requestor.id ? requestor.id : AI_AGENT_PRINCIPAL_FALLBACK;
}

/**
 * Compose the stored `description` for an agent-created response-task. The
 * operator-facing text is kept verbatim; a delimited provenance footer is
 * appended so the AI origin, the agent's reasoning, and the source the task
 * was derived from are visible on the atom itself (WSC.5 — "no new
 * persistence", so provenance rides the existing `description` column).
 */
export function composeAgentTaskDescription(input: {
  description: string;
  reasoning: string;
  findingId: string | null;
  sourceClientCommentId: string | null;
  severity: string | null;
  confidence: number | null;
}): string {
  const src: string[] = [];
  if (input.findingId) src.push(`finding ${input.findingId}`);
  if (input.sourceClientCommentId) {
    src.push(`client comment ${input.sourceClientCommentId}`);
  }
  if (input.severity) src.push(`severity ${input.severity}`);
  if (input.confidence !== null) src.push(`confidence ${input.confidence}`);
  const srcSuffix = src.length > 0 ? ` (source: ${src.join("; ")})` : "";
  const footer = `[AI-drafted by the Cortex in-app agent] ${input.reasoning}${srcSuffix}`;
  const base = input.description.trim();
  return base.length > 0 ? `${base}\n\n${footer}` : footer;
}

/* -------------------------------------------------------------------------- */
/*  Tool definitions                                                          */
/* -------------------------------------------------------------------------- */

const EMPTY_INPUT = {
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

/**
 * The tools the in-app agent may call. Every tool operates only on the
 * engagement the chat turn is about — there is no `engagementId` input.
 */
export const CHAT_AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "list_sheets",
    description:
      "List the drawing sheets captured for the current engagement (sheet id, number, name). Use this before read_sheet.",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "read_sheet",
    description:
      "Read one sheet of the current engagement: its metadata, extracted text body, and any OCR content extraction. Pass a sheetId returned by list_sheets.",
    input_schema: {
      type: "object",
      properties: {
        sheetId: { type: "string", description: "Sheet id from list_sheets." },
      },
      required: ["sheetId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_findings",
    description:
      "List the compliance findings on the current engagement's most recent submission, including severity and confidence. Use these when drafting response tasks so severity/confidence propagate onto the task.",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "list_submissions",
    description:
      "List the plan-review submissions for the current engagement (id, status, discipline, timestamps).",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "list_snapshots",
    description:
      "List the Revit snapshots for the current engagement (id, capture time, sheet/room/level/wall counts).",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "list_response_tasks",
    description:
      "List the response tasks (L1) for the current engagement. Optionally filter by state.",
    input_schema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["open", "in-progress", "done", "cancelled"],
          description: "Optional state filter.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_detail_callout_specs",
    description:
      "List the detail-callout specs (L4) for the current engagement (id, detail type, push state).",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "list_product_spec_references",
    description:
      "List the product-spec references (L5) for the current engagement (id, product, manufacturer, ESR number, status).",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "read_site_context",
    description:
      "Read the current engagement's site context: the latest parcel-briefing sections and the briefing data sources behind the Site Context tab.",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "list_attached_documents",
    description:
      "List the client documents the operator has uploaded to the current engagement — PDFs, photos, and notes (id, title, document type, upload time, whether it carries readable text). Use this to see what client material is available, then read_attached_document to read one.",
    input_schema: EMPTY_INPUT,
  },
  {
    name: "read_attached_document",
    description:
      "Read one uploaded client document of the current engagement: its title, type, and extracted/operator-supplied text. Pass an attachedDocumentId returned by list_attached_documents. Use this to ground answers in client-supplied material instead of asking the operator to re-paste it.",
    input_schema: {
      type: "object",
      properties: {
        attachedDocumentId: {
          type: "string",
          description: "Attached-document id from list_attached_documents.",
        },
      },
      required: ["attachedDocumentId"],
      additionalProperties: false,
    },
  },
  {
    name: "create_response_tasks",
    description:
      "Create one or more response tasks (L1) on the current engagement. Use this to push review findings or client-comment responses onto the Response Tasks board. Each task is created with state 'open', is reversible (it can be cancelled), and is stamped as AI-drafted. Always provide a one-line `reasoning`, and cite the source finding/comment plus its severity/confidence when the task derives from one.",
    input_schema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: MAX_TASKS_PER_CALL,
          description: "The tasks to create. Pass one item for a single task.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Short task title." },
              description: {
                type: "string",
                description: "Task detail (may be empty).",
              },
              reasoning: {
                type: "string",
                description:
                  "One line: why this task exists / how it was derived. Required — recorded as provenance.",
              },
              findingId: {
                type: "string",
                description: "Source finding id, when derived from a finding.",
              },
              sourceClientCommentId: {
                type: "string",
                description: "Source client-comment id, when applicable.",
              },
              severity: {
                type: "string",
                description: "Severity carried over from the source finding.",
              },
              confidence: {
                type: "number",
                description: "Confidence carried over from the source finding.",
              },
              dueAt: {
                type: "string",
                description: "Optional ISO-8601 due date.",
              },
            },
            required: ["title", "reasoning"],
            additionalProperties: false,
          },
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_detail_callout_spec",
    description:
      "Prepare a detail-callout spec (L4) DRAFT for the current engagement and open it in the manual form for the operator to review, edit, and save. This does NOT persist anything — the operator saves it. The `spec` object is a discriminated union keyed on `detailType`: 'room-finish' {roomName,roomNumber,floorFinish,baseFinish,wallFinish,ceilingFinish,ceilingHeight}; 'wall-type' {typeMark,assemblyLayers:[{material,thickness,function}],fireRating,stcRating}; 'wall-section' {sectionMark,cutLocation,assemblyLayers:[...],baseDatum,topDatum}; 'door-schedule' {rows:[{doorMark,doorType,width,height,material,fireRating,hardwareSet}]}.",
    input_schema: {
      type: "object",
      properties: {
        spec: {
          type: "object",
          description:
            "The detail-callout spec payload (discriminated on detailType).",
        },
        reasoning: {
          type: "string",
          description: "One line: why this spec, for the form banner.",
        },
        findingId: { type: "string", description: "Source finding id." },
        responseTaskId: {
          type: "string",
          description: "Related response-task id, when applicable.",
        },
      },
      required: ["spec", "reasoning"],
      additionalProperties: false,
    },
  },
  {
    name: "draft_product_spec_reference",
    description:
      "Prepare a product-spec reference (L5) DRAFT for the current engagement and open it in the manual form for the operator to review, edit, and save. This does NOT persist anything — the operator saves it. `esrNumber` must match the ICC-ES report format `ESR-####`.",
    input_schema: {
      type: "object",
      properties: {
        product: {
          type: "object",
          properties: {
            name: { type: "string" },
            manufacturer: { type: "string" },
          },
          required: ["name", "manufacturer"],
          additionalProperties: false,
        },
        esrNumber: {
          type: "string",
          description: "ICC-ES report number, format ESR-#### (e.g. ESR-1234).",
        },
        reasoning: {
          type: "string",
          description: "One line: why this reference, for the form banner.",
        },
        findingId: { type: "string", description: "Source finding id." },
        responseTaskId: {
          type: "string",
          description: "Related response-task id, when applicable.",
        },
      },
      required: ["product", "esrNumber", "reasoning"],
      additionalProperties: false,
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  System-prompt guidance                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tool-use guidance appended to the chat system prompt (in `chat.ts`, so
 * `@workspace/codes` stays pure). Carries the ambient context (which
 * engagement is open, which tab the operator is viewing) and the
 * quality-gate rule for agent writes.
 */
export function buildAgentToolGuidance(input: {
  engagementName: string;
  activeTab: string | null;
}): string {
  const tabLine = input.activeTab
    ? ` The operator is currently viewing the "${input.activeTab}" tab.`
    : "";
  return (
    "\n\n" +
    "You have tools to read this engagement's platform state and to act on it. " +
    `The operator has the engagement "${input.engagementName}" open.${tabLine} ` +
    "Use the read tools (list_sheets, read_sheet, list_findings, list_submissions, " +
    "list_snapshots, list_response_tasks, list_detail_callout_specs, " +
    "list_product_spec_references, read_site_context, list_attached_documents, " +
    "read_attached_document) to ground answers in real data instead of asking " +
    "the operator to paste it.\n\n" +
    "Client documents the operator uploaded to this engagement (PDFs, photos, " +
    "notes) are available via list_attached_documents / read_attached_document — " +
    "check there before assuming a piece of client material was not provided.\n\n" +
    "When the operator asks you to push review findings or comment responses to " +
    "the task board, call create_response_tasks (it accepts one task or a batch). " +
    "Every task you create must carry a one-line `reasoning`; when a task derives " +
    "from a finding, pass its `findingId`, `severity`, and `confidence` so the " +
    "provenance propagates. Agent-created tasks are reversible (the operator can " +
    "cancel them) and are marked as AI-drafted.\n\n" +
    "For detail-callout specs (L4) and product-spec references (L5), use " +
    "draft_detail_callout_spec / draft_product_spec_reference. These do not save " +
    "anything — they open the manual form pre-filled so the operator reviews and " +
    "saves. Tell the operator the draft is waiting for review in the form."
  );
}

/* -------------------------------------------------------------------------- */
/*  Read handlers                                                             */
/* -------------------------------------------------------------------------- */

async function handleListSheets(ctx: ToolContext): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: sheets.id,
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      snapshotId: sheets.snapshotId,
    })
    .from(sheets)
    .where(eq(sheets.engagementId, ctx.engagementId))
    .orderBy(desc(sheets.sortOrder))
    .limit(MAX_LIST_ROWS);
  return { resultText: asJson({ sheetCount: rows.length, sheets: rows }) };
}

async function handleReadSheet(
  ctx: ToolContext,
  input: unknown,
): Promise<ToolRunResult> {
  const sheetId = isRecord(input) ? optionalString(input.sheetId) : null;
  if (!sheetId) {
    return { resultText: "Error: `sheetId` is required.", isError: true };
  }
  const [sheet] = await db
    .select({
      id: sheets.id,
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      contentBody: sheets.contentBody,
    })
    .from(sheets)
    .where(
      and(eq(sheets.id, sheetId), eq(sheets.engagementId, ctx.engagementId)),
    )
    .limit(1);
  if (!sheet) {
    return {
      resultText: `Error: sheet ${sheetId} not found on this engagement.`,
      isError: true,
    };
  }
  const [extraction] = await db
    .select({
      pageLabel: sheetContentExtractions.pageLabel,
      extractedTextSegments: sheetContentExtractions.extractedTextSegments,
      structuredAnnotations: sheetContentExtractions.structuredAnnotations,
    })
    .from(sheetContentExtractions)
    .where(eq(sheetContentExtractions.sourceSheetId, sheetId))
    .orderBy(desc(sheetContentExtractions.createdAt))
    .limit(1);
  return {
    resultText: asJson({
      id: sheet.id,
      sheetNumber: sheet.sheetNumber,
      sheetName: sheet.sheetName,
      contentBody: sheet.contentBody ?? null,
      contentExtraction: extraction ?? null,
    }),
  };
}

async function handleListFindings(ctx: ToolContext): Promise<ToolRunResult> {
  const [latest] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.engagementId, ctx.engagementId))
    .orderBy(desc(submissions.createdAt))
    .limit(1);
  if (!latest) {
    return { resultText: asJson({ findingCount: 0, findings: [] }) };
  }
  const rows = await db
    .select({
      id: findings.atomId,
      severity: findings.severity,
      category: findings.category,
      confidence: findings.confidence,
      status: findings.status,
      text: findings.text,
      elementRef: findings.elementRef,
    })
    .from(findings)
    .where(eq(findings.submissionId, latest.id))
    .limit(MAX_LIST_ROWS);
  return {
    resultText: asJson({
      submissionId: latest.id,
      findingCount: rows.length,
      findings: rows,
    }),
  };
}

async function handleListSubmissions(ctx: ToolContext): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: submissions.id,
      status: submissions.status,
      discipline: submissions.discipline,
      note: submissions.note,
      submittedAt: submissions.submittedAt,
    })
    .from(submissions)
    .where(eq(submissions.engagementId, ctx.engagementId))
    .orderBy(desc(submissions.createdAt))
    .limit(MAX_LIST_ROWS);
  return { resultText: asJson({ submissionCount: rows.length, submissions: rows }) };
}

async function handleListSnapshots(ctx: ToolContext): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: snapshots.id,
      projectName: snapshots.projectName,
      receivedAt: snapshots.receivedAt,
      sheetCount: snapshots.sheetCount,
      roomCount: snapshots.roomCount,
      levelCount: snapshots.levelCount,
      wallCount: snapshots.wallCount,
    })
    .from(snapshots)
    .where(eq(snapshots.engagementId, ctx.engagementId))
    .orderBy(desc(snapshots.receivedAt))
    .limit(MAX_LIST_ROWS);
  return { resultText: asJson({ snapshotCount: rows.length, snapshots: rows }) };
}

async function handleListResponseTasks(
  ctx: ToolContext,
  input: unknown,
): Promise<ToolRunResult> {
  const state = isRecord(input) ? optionalString(input.state) : null;
  const where =
    state === null
      ? eq(responseTasks.engagementId, ctx.engagementId)
      : and(
          eq(responseTasks.engagementId, ctx.engagementId),
          eq(responseTasks.state, state),
        );
  const rows = await db
    .select({
      id: responseTasks.id,
      title: responseTasks.title,
      description: responseTasks.description,
      state: responseTasks.state,
      dueAt: responseTasks.dueAt,
      findingId: responseTasks.findingId,
      actorId: responseTasks.actorId,
    })
    .from(responseTasks)
    .where(where)
    .orderBy(desc(responseTasks.createdAt))
    .limit(MAX_LIST_ROWS);
  return { resultText: asJson({ taskCount: rows.length, responseTasks: rows }) };
}

async function handleListDetailCalloutSpecs(
  ctx: ToolContext,
): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: detailCalloutSpecs.id,
      spec: detailCalloutSpecs.spec,
      pushState: detailCalloutSpecs.pushState,
      createdAt: detailCalloutSpecs.createdAt,
    })
    .from(detailCalloutSpecs)
    .where(eq(detailCalloutSpecs.engagementId, ctx.engagementId))
    .orderBy(desc(detailCalloutSpecs.createdAt))
    .limit(MAX_LIST_ROWS);
  const specs = rows.map((r) => ({
    id: r.id,
    detailType: (r.spec as { detailType?: string } | null)?.detailType ?? null,
    pushState: r.pushState,
    createdAt: r.createdAt,
  }));
  return { resultText: asJson({ specCount: specs.length, detailCalloutSpecs: specs }) };
}

async function handleListProductSpecReferences(
  ctx: ToolContext,
): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: productSpecReferences.id,
      productName: productSpecReferences.productName,
      productManufacturer: productSpecReferences.productManufacturer,
      esrNumber: productSpecReferences.esrNumber,
      status: productSpecReferences.status,
    })
    .from(productSpecReferences)
    .where(eq(productSpecReferences.engagementId, ctx.engagementId))
    .orderBy(desc(productSpecReferences.createdAt))
    .limit(MAX_LIST_ROWS);
  return {
    resultText: asJson({
      referenceCount: rows.length,
      productSpecReferences: rows,
    }),
  };
}

async function handleReadSiteContext(ctx: ToolContext): Promise<ToolRunResult> {
  const [briefing] = await db
    .select()
    .from(parcelBriefings)
    .where(eq(parcelBriefings.engagementId, ctx.engagementId))
    .orderBy(desc(parcelBriefings.createdAt))
    .limit(1);
  if (!briefing) {
    return {
      resultText: asJson({
        hasBriefing: false,
        message: "No parcel briefing generated for this engagement yet.",
      }),
    };
  }
  const sources = await db
    .select({
      layerKind: briefingSources.layerKind,
      sourceKind: briefingSources.sourceKind,
      provider: briefingSources.provider,
      conversionStatus: briefingSources.conversionStatus,
    })
    .from(briefingSources)
    .where(eq(briefingSources.briefingId, briefing.id))
    .limit(MAX_LIST_ROWS);
  return {
    resultText: asJson({
      hasBriefing: true,
      sections: {
        A: briefing.sectionA,
        B: briefing.sectionB,
        C: briefing.sectionC,
        D: briefing.sectionD,
        E: briefing.sectionE,
        F: briefing.sectionF,
        G: briefing.sectionG,
      },
      sourceCount: sources.length,
      sources,
    }),
  };
}

async function handleListAttachedDocuments(
  ctx: ToolContext,
): Promise<ToolRunResult> {
  const rows = await db
    .select({
      id: attachedDocuments.id,
      title: attachedDocuments.title,
      documentType: attachedDocuments.documentType,
      extractedText: attachedDocuments.extractedText,
      createdAt: attachedDocuments.createdAt,
    })
    .from(attachedDocuments)
    .where(eq(attachedDocuments.engagementId, ctx.engagementId))
    .orderBy(desc(attachedDocuments.createdAt))
    .limit(MAX_LIST_ROWS);
  return {
    resultText: asJson({
      attachedDocumentCount: rows.length,
      attachedDocuments: rows.map((r) => ({
        id: r.id,
        title: r.title,
        documentType: r.documentType,
        uploadedAt: r.createdAt,
        hasReadableText: r.extractedText.trim().length > 0,
        textPreview: r.extractedText.slice(0, 200),
      })),
    }),
  };
}

async function handleReadAttachedDocument(
  ctx: ToolContext,
  input: unknown,
): Promise<ToolRunResult> {
  const attachedDocumentId = isRecord(input)
    ? optionalString(input.attachedDocumentId)
    : null;
  if (!attachedDocumentId) {
    return {
      resultText: "Error: `attachedDocumentId` is required.",
      isError: true,
    };
  }
  const [doc] = await db
    .select({
      id: attachedDocuments.id,
      title: attachedDocuments.title,
      documentType: attachedDocuments.documentType,
      extractedText: attachedDocuments.extractedText,
      createdAt: attachedDocuments.createdAt,
    })
    .from(attachedDocuments)
    .where(
      and(
        eq(attachedDocuments.id, attachedDocumentId),
        eq(attachedDocuments.engagementId, ctx.engagementId),
      ),
    )
    .limit(1);
  if (!doc) {
    return {
      resultText: `Error: attached document ${attachedDocumentId} not found on this engagement.`,
      isError: true,
    };
  }
  return {
    resultText: asJson({
      id: doc.id,
      title: doc.title,
      documentType: doc.documentType,
      uploadedAt: doc.createdAt,
      extractedText:
        doc.extractedText.trim().length > 0
          ? doc.extractedText
          : "(no readable text — this document was stored as a binary file with no note)",
    }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Write handler — create_response_tasks (WSC.3 + WSC.5)                      */
/* -------------------------------------------------------------------------- */

async function handleCreateResponseTasks(
  ctx: ToolContext,
  input: unknown,
): Promise<ToolRunResult> {
  const rawTasks =
    isRecord(input) && Array.isArray(input.tasks) ? input.tasks : null;
  if (!rawTasks || rawTasks.length === 0) {
    return {
      resultText: "Error: `tasks` must be a non-empty array.",
      isError: true,
    };
  }
  if (rawTasks.length > MAX_TASKS_PER_CALL) {
    return {
      resultText: `Error: at most ${MAX_TASKS_PER_CALL} tasks per call.`,
      isError: true,
    };
  }

  // Engagement existence — mirrors the L1 route's 404 guard.
  const [engagement] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(eq(engagements.id, ctx.engagementId))
    .limit(1);
  if (!engagement) {
    return {
      resultText: `Error: engagement ${ctx.engagementId} not found.`,
      isError: true,
    };
  }

  const principalActorId = resolvePrincipalActorId(ctx.req);
  const created: Array<{ id: string; title: string; state: string }> = [];
  const events: AgentSideEffect[] = [];

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i];
    if (!isRecord(raw)) {
      return {
        resultText: `Error: task at index ${i} is not an object.`,
        isError: true,
      };
    }
    const reasoning = optionalString(raw.reasoning);
    if (!reasoning) {
      return {
        resultText: `Error: task at index ${i} is missing the required \`reasoning\`.`,
        isError: true,
      };
    }
    const severity = optionalString(raw.severity);
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? raw.confidence
        : null;

    // Reuse the L1 route's body validator so an agent-created task is
    // validated identically to an operator-created one.
    const parsed = parseCreateResponseTaskBody({
      title: raw.title,
      description: composeAgentTaskDescription({
        description: typeof raw.description === "string" ? raw.description : "",
        reasoning,
        findingId: optionalString(raw.findingId),
        sourceClientCommentId: optionalString(raw.sourceClientCommentId),
        severity,
        confidence,
      }),
      findingId: raw.findingId,
      sourceClientCommentId: raw.sourceClientCommentId,
      dueAt: raw.dueAt,
      // The AI-origin marker (WSC.5). The operator is the principal.
      actorId: AI_AGENT_ACTOR_ID,
      principalActorId,
    });
    if (!parsed.ok) {
      return {
        resultText: `Error: task at index ${i} is invalid (${parsed.error}).`,
        isError: true,
      };
    }

    const [row] = await db
      .insert(responseTasks)
      .values({
        engagementId: ctx.engagementId,
        title: parsed.value.title,
        description: parsed.value.description,
        state: "open",
        dueAt: parsed.value.dueAt ? new Date(parsed.value.dueAt) : null,
        sourceClientCommentId: parsed.value.sourceClientCommentId,
        findingId: parsed.value.findingId,
        actorId: parsed.value.actorId,
        principalActorId: parsed.value.principalActorId,
      })
      .returning();
    if (!row) {
      throw new Error("response_tasks insert returned no row");
    }

    // Audit event — same `response-task.opened` type the L1 route emits,
    // with the structured provenance the WSC.5 guardrail requires.
    await recordLSurfaceEvent(ctx.reqLog, {
      entityType: "response-task",
      entityId: row.id,
      eventType: "response-task.opened",
      actor: { kind: "agent", id: AI_AGENT_ACTOR_ID },
      payload: {
        engagementId: ctx.engagementId,
        title: row.title,
        findingId: parsed.value.findingId,
        sourceClientCommentId: parsed.value.sourceClientCommentId,
        aiOriginated: true,
        agentReasoning: reasoning,
        ...(severity ? { severity } : {}),
        ...(confidence !== null ? { confidence } : {}),
      },
    });

    created.push({ id: row.id, title: row.title, state: row.state });
    events.push({
      type: "agent_action",
      action: {
        kind: "response-task-created",
        entityType: "response-task",
        entityId: row.id,
        engagementId: ctx.engagementId,
        label: row.title,
        reversible: true,
        reverseHint: "cancel",
      },
    });
  }

  return {
    resultText: asJson({
      createdCount: created.length,
      responseTasks: created,
      note: "Tasks are on the Response Tasks tab and can be cancelled to undo.",
    }),
    events,
  };
}

/* -------------------------------------------------------------------------- */
/*  Draft handlers — L4 / L5 (WSC.4)                                          */
/* -------------------------------------------------------------------------- */

function handleDraftDetailCalloutSpec(
  ctx: ToolContext,
  input: unknown,
): ToolRunResult {
  if (!isRecord(input)) {
    return { resultText: "Error: invalid input.", isError: true };
  }
  const reasoning = optionalString(input.reasoning);
  if (!reasoning) {
    return { resultText: "Error: `reasoning` is required.", isError: true };
  }
  // Validate against the same schema the L4 route uses so the draft is
  // guaranteed form-valid before it reaches the operator.
  const specResult = DETAIL_CALLOUT_SPEC_PAYLOAD_SCHEMA.safeParse(input.spec);
  if (!specResult.success) {
    return {
      resultText:
        "Error: `spec` failed validation. Fix it and retry. " +
        truncate(JSON.stringify(specResult.error.issues), 2000),
      isError: true,
    };
  }
  return {
    resultText: asJson({
      drafted: true,
      detailType: specResult.data.detailType,
      note: "Draft opened in the Detail Callouts form for operator review and save.",
    }),
    events: [
      {
        type: "agent_draft",
        draft: {
          draftKind: "detail-callout-spec",
          engagementId: ctx.engagementId,
          payload: {
            spec: specResult.data,
            findingId: optionalString(input.findingId),
            responseTaskId: optionalString(input.responseTaskId),
          },
          reasoning,
        },
      },
    ],
  };
}

function handleDraftProductSpecReference(
  ctx: ToolContext,
  input: unknown,
): ToolRunResult {
  if (!isRecord(input)) {
    return { resultText: "Error: invalid input.", isError: true };
  }
  const reasoning = optionalString(input.reasoning);
  if (!reasoning) {
    return { resultText: "Error: `reasoning` is required.", isError: true };
  }
  const product = isRecord(input.product) ? input.product : null;
  const name = product ? optionalString(product.name) : null;
  const manufacturer = product ? optionalString(product.manufacturer) : null;
  if (!name || !manufacturer) {
    return {
      resultText: "Error: `product.name` and `product.manufacturer` are required.",
      isError: true,
    };
  }
  const esrNumber = optionalString(input.esrNumber);
  if (!esrNumber || !ESR_NUMBER_RE.test(esrNumber)) {
    return {
      resultText: "Error: `esrNumber` must match the format ESR-#### (e.g. ESR-1234).",
      isError: true,
    };
  }
  return {
    resultText: asJson({
      drafted: true,
      esrNumber,
      note: "Draft opened in the Product Specs form for operator review and save.",
    }),
    events: [
      {
        type: "agent_draft",
        draft: {
          draftKind: "product-spec-reference",
          engagementId: ctx.engagementId,
          payload: {
            product: { name, manufacturer },
            esrNumber,
            findingId: optionalString(input.findingId),
            responseTaskId: optionalString(input.responseTaskId),
          },
          reasoning,
        },
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  Dispatcher                                                                */
/* -------------------------------------------------------------------------- */

/** True for the names in {@link CHAT_AGENT_TOOLS}. */
export function isAgentToolName(name: string): boolean {
  return CHAT_AGENT_TOOLS.some((t) => t.name === name);
}

/**
 * Run one tool in-process and return its result. Never throws for a tool-
 * level failure (bad input, missing row) — those come back as
 * `{ isError: true }` so the model can recover or report. A genuine
 * infrastructure failure (DB down) does throw; the caller wraps it.
 */
export async function executeAgentTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolRunResult> {
  switch (name) {
    case "list_sheets":
      return handleListSheets(ctx);
    case "read_sheet":
      return handleReadSheet(ctx, input);
    case "list_findings":
      return handleListFindings(ctx);
    case "list_submissions":
      return handleListSubmissions(ctx);
    case "list_snapshots":
      return handleListSnapshots(ctx);
    case "list_response_tasks":
      return handleListResponseTasks(ctx, input);
    case "list_detail_callout_specs":
      return handleListDetailCalloutSpecs(ctx);
    case "list_product_spec_references":
      return handleListProductSpecReferences(ctx);
    case "read_site_context":
      return handleReadSiteContext(ctx);
    case "list_attached_documents":
      return handleListAttachedDocuments(ctx);
    case "read_attached_document":
      return handleReadAttachedDocument(ctx, input);
    case "create_response_tasks":
      return handleCreateResponseTasks(ctx, input);
    case "draft_detail_callout_spec":
      return handleDraftDetailCalloutSpec(ctx, input);
    case "draft_product_spec_reference":
      return handleDraftProductSpecReference(ctx, input);
    default:
      return {
        resultText: `Error: unknown tool "${name}".`,
        isError: true,
      };
  }
}
