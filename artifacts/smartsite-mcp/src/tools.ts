import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SMARTSITE_MCP_TOOLS, type SmartsiteToolName } from "./constants.js";
import {
  cortexFetch,
  loadCortexClientConfig,
  type CortexClientConfig,
} from "./cortex-client.js";
import {
  canRunDeepReport,
  canRunStudioReport,
  isStudioExportKind,
  refuseDeepReport,
  refuseStudioReport,
  snapshotFromAuth,
} from "./entitlement.js";
import {
  ANCHOR_TIMEOUT_MS,
  anchorFromFacetsBody,
  attachAnchorToResponseText,
  attachBatchAnchorsToResponseText,
  parcelFacetsPath,
  readParcelAnchor,
  readParcelAnchorsForBatch,
  skippedAnchorForStub,
  type AnchorOutcome,
  type BatchAnchorOutcome,
} from "./parcel-anchor.js";
import { requireAuthContext } from "./request-context.js";
import {
  executeExportInstrument,
  exportKindNotAvailableResult,
} from "./export-instrument.js";
import { listPurchasedRecords, readPurchasedRecord } from "./recordsExtraction.js";
import {
  buildRunReportEnvelope,
  declarePlaceSearchRefusal,
  declareUpstreamNonOk,
  mapGetSmartSiteNonOk,
  mapScreensGateNonOk,
  missClassDisplayText,
  normalizeGetSmartSiteResponseText,
  outOfCoverageAgentGuidance,
  stripSavedPropertiesForExternal,
} from "./tool-honesty.js";
import type { ToolResult } from "./tools-types.js";
import { appMetaFor, registerMcpApp } from "./mcp-app.js";
import {
  registerVocabularyResource,
  STANDING_VOCAB_CONTENT_PART,
} from "./vocabulary.js";

const SMARTSITE_BATCH_CAP = 50;
/**
 * H2 (measured 2026-08-30 on p557): a node body averages 4,711 characters
 * (largest 5,549), and the host writes any tool result over roughly 150,000
 * characters to a file and hands the panel a pointer, so a 50-id node batch
 * (about 235,000) never reaches the panel. Node arrays cap at 25; stub keeps
 * 50. The JSON schema cannot express a depth-dependent cap, so the array
 * stays max(50) there and this rule is enforced here and published in the
 * description.
 */
const SMARTSITE_NODE_BATCH_CAP = 25;
const GET_SMART_SITE_DEPTHS = ["stub", "node", "hop1", "subgraph"] as const;
type ImplementedDepth = "stub" | "node";

function batchCapFor(depth: ImplementedDepth): number {
  return depth === "node" ? SMARTSITE_NODE_BATCH_CAP : SMARTSITE_BATCH_CAP;
}
const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
const SCREEN_ROW_SOURCES = ["walk", "saved", "pasted"] as const;

/**
 * P-91 v3 Q1. Mirrors PARCEL_NODE_ID_RE in
 * artifacts/api-server/src/routes/brokeragePlaceSitusSearch.ts (read
 * 2026-08-31): county FIPS, colon, county-assigned parcel id. Used to pick
 * find_parcel's `near` centre-point path — a parcel node id reads the
 * anchor (node facets) route the same way M-1 does; anything else geocodes
 * as free text via place/resolve.
 */
const PARCEL_NODE_ID_RE = /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Mirror RADIUS_SEARCH_CAP / STREET_SEARCH_CAP in
 * artifacts/api-server/src/lib/txgioRadiusSearch.ts /
 * txgioStreetSearch.ts (both 50, read 2026-08-31). Bounds the LOCAL `cap`
 * argument at the MCP schema so a caller mistake on cap fails at the tool
 * boundary instead of a round trip. Deliberately NOT applied to
 * `near.radiusFt`: that bound is exactly what radius_exceeds_max exists to
 * refuse, and pre-validating it here would make that refusal code
 * unreachable through this tool.
 */
const FIND_PARCEL_NEAR_CAP_MAX = 50;
const FIND_PARCEL_STREET_CAP_MAX = 50;

/**
 * P-106. Mirrors CONSTRAINT_SEARCH_MAX_CAP in
 * artifacts/api-server/src/lib/parcelConstraintSearch.ts (200, read
 * 2026-09-02). Bounds the LOCAL `cap` so a caller mistake fails at the tool
 * boundary rather than a round trip. The county list and the unmeasured
 * ceiling are deliberately NOT mirrored here: the first would go stale the
 * day a county is added, and the second is an operator ruling that lives with
 * the measurement, not in a package that cannot verify it.
 */
const FIND_PARCELS_CAP_MAX = 200;

/**
 * The filter grammar, closed at the tool boundary. Every member is strict, so
 * an extra key is a rejection rather than a silently ignored field, and an
 * unrecognised op never reaches the SQL builder.
 */
const FIND_PARCELS_FILTER = z.union([
  z
    .object({
      rail: z.string().min(1),
      op: z.enum(["gte", "lte"]),
      number: z.number(),
    })
    .strict(),
  z
    .object({ rail: z.string().min(1), op: z.literal("eq"), number: z.number() })
    .strict(),
  z
    .object({ rail: z.string().min(1), op: z.literal("eq"), text: z.string().min(1) })
    .strict(),
  z
    .object({
      rail: z.string().min(1),
      op: z.literal("in"),
      texts: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ rail: z.string().min(1), op: z.literal("absent") }).strict(),
  z
    .object({ rail: z.string().min(1), op: z.enum(["is_true", "is_false"]) })
    .strict(),
]);

const ASK_THE_MAP_REFUSAL = "ask_the_map accepts parcelNodeId and message.";
const ASK_THE_MAP_STRICT = z
  .object({
    parcelNodeId: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/**
 * Strict at the type: tools/list publishes additionalProperties false and
 * the SDK refuses extra keys before the handler runs. The SDK prints every
 * zod issue verbatim, and a strict object's unrecognized_keys issue names
 * the extra keys, which is the P-91 item 10 leak on the MCP error path.
 * This instance keeps the strict schema (same shape, same published JSON
 * schema) and replaces only that issue with a fixed sentence.
 */
function askTheMapInputSchema(): typeof ASK_THE_MAP_STRICT {
  const guarded: typeof ASK_THE_MAP_STRICT = Object.create(ASK_THE_MAP_STRICT);
  guarded.safeParseAsync = async (data: unknown) => {
    const result = await ASK_THE_MAP_STRICT.safeParseAsync(data);
    if (
      result.success ||
      !result.error.issues.some((issue) => issue.code === "unrecognized_keys")
    ) {
      return result;
    }
    return {
      success: false,
      error: new z.ZodError([
        { code: z.ZodIssueCode.custom, path: [], message: ASK_THE_MAP_REFUSAL },
      ]),
    };
  };
  return guarded;
}

/**
 * P-91 QA 2026-08-30 D1. Cortex situs-search merges parcel hits with
 * address-point rows (`parcelNodeId: null`, lat/lon) that exist for the web
 * typeahead. To a third-party agent a null id inside `hits` is a trap. Here
 * `hits` carries parcel hits only; when there is no parcel hit, the address
 * points move to `located` (typed, never a hit) so a caller can say "address
 * exists, parcel not bound" instead of "no match". Non-JSON bodies pass through.
 *
 * P-107 (OPS-16 A-072). Cortex may also carry `missClass: "out_of_coverage"`
 * (plus `outOfCoverageState`) straight through from searchPlaceByPrefix —
 * the query resolved to a state Smart Site's store has not reached, fired
 * BEFORE the store was ever searched, so there is no `located` row to move
 * here either. That token is enriched with `missClassDisplayText` and
 * `agentGuidance` (read from the shared VOCABULARY / mirrored coverage
 * constant in tool-honesty.ts) so a caller reads a served answer — what IS
 * covered today — rather than a bare, unexplained machine token. `no-hit`
 * and `located-unbound` are left exactly as they were: unenriched.
 */
export function splitFindParcelHits(bodyText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyText;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.hits)) return bodyText;
  const parcelHits: unknown[] = [];
  const located: unknown[] = [];
  for (const raw of record.hits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const hit = raw as Record<string, unknown>;
    if (typeof hit.parcelNodeId === "string" && hit.parcelNodeId.length > 0) {
      parcelHits.push(hit);
    } else if (hit.source === "address-point") {
      const { parcelNodeId: _null, ...point } = hit;
      located.push(point);
    }
  }
  const out: Record<string, unknown> = { ...record, hits: parcelHits };
  if (parcelHits.length === 0 && located.length > 0) {
    out.located = located;
    if (out.missClass === undefined) out.missClass = "located-unbound";
  }
  if (out.missClass === "out_of_coverage") {
    out.missClassDisplayText = missClassDisplayText("out_of_coverage");
    out.agentGuidance = outOfCoverageAgentGuidance(
      typeof record.outOfCoverageState === "string"
        ? record.outOfCoverageState
        : undefined,
    );
  }
  return JSON.stringify(out);
}

function notReadyMessage(tool: string, reason: string): string {
  return JSON.stringify({
    status: "not_ready",
    tool,
    reason,
    message: `${tool} is not available on Smart Site MCP yet.`,
  });
}

function degradedResult(reason: string, message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "degraded", reason, message }),
      },
    ],
    isError: true,
  };
}

function upgradeRequiredResult(
  refusal: ReturnType<typeof refuseDeepReport>,
): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(refusal) }],
    isError: true,
  };
}

/** H1: a cortex non-OK travels as a declared error body, never raw. */
function upstreamErrorResult(httpStatus: number, bodyText: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(declareUpstreamNonOk(httpStatus, bodyText)),
      },
    ],
    isError: true,
  };
}

/**
 * A refusal this server itself makes (as opposed to one it relays from an
 * upstream serve_refused body — see declarePlaceSearchRefusal in
 * tool-honesty.ts for that case, which carries its own shape). `reason` is
 * a machine token, matching this file's own convention (parcel_batch_cap,
 * screen_id_not_accepted); `extra` carries any additional declared fields
 * (e.g. the parcelNodeId and anchorRead a near centre-point miss names).
 */
function declaredRefusalResult(
  reason: string,
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ status: "refused", reason, message, ...extra }),
      },
    ],
    isError: true,
  };
}

function isDeclaredErrorText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    return (
      typeof rec.status === "string" &&
      rec.status.length > 0 &&
      typeof rec.reason === "string" &&
      rec.reason.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * H1 for a result built outside this file (the export proxy): an error
 * result whose text is not already a declared body is wrapped here. The
 * upstream HTTP status did not travel with it, so it is `"unmeasured"`,
 * never a guessed number.
 */
function ensureDeclaredError(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  const text = result.content[0]?.text;
  if (typeof text !== "string" || isDeclaredErrorText(text)) return result;
  return {
    ...result,
    content: [
      {
        type: "text",
        text: JSON.stringify(declareUpstreamNonOk("unmeasured", text)),
      },
    ],
  };
}

async function withCortex(
  fn: (config: CortexClientConfig) => Promise<ToolResult>,
): Promise<ToolResult> {
  const config = loadCortexClientConfig();
  if (!config) {
    return degradedResult(
      "cortex_not_configured",
      "Smart Site MCP cannot reach the workbench backend.",
    );
  }
  return fn(config);
}

type CenterPointOutcome =
  | { ok: true; lat: number; lng: number }
  | { ok: false; result: ToolResult };

/**
 * P-91 v3 Q1. find_parcel's `near` needs one absolute point to search a
 * radius around. Three ways to get one exist on cortex today: situs-search
 * address-point hits carry latitude/longitude; POST place/resolve geocodes
 * any address; the node facets route serves cityLimitsFact.queryPoint per
 * parcel (parcel-anchor.ts's M-1 anchor).
 *
 * situs-search is not used here. Its parcel-situs hits — the common case
 * when `query` already names a known parcel — carry no coordinate at all
 * (SitusSearchHit in txgioAddressResolve.ts has no lat/lng field; only the
 * rarer address-point hits do), so routing through it would still need a
 * second lookup for the common case and buys nothing over calling the
 * right one of the other two directly.
 *
 * A parcel node id reads the same facets route M-1's anchor already reads,
 * reusing anchorFromFacetsBody's own honesty rules verbatim: no 0,0
 * sentinel, no centroid guess, a miss is declared rather than defaulted. A
 * free-text query geocodes through place/resolve.
 */
async function resolveNearCenterPoint(
  config: CortexClientConfig,
  query: string,
  userId: string | undefined,
): Promise<CenterPointOutcome> {
  if (PARCEL_NODE_ID_RE.test(query)) {
    const res = await cortexFetch(config, parcelFacetsPath(query), {
      userId,
      timeoutMs: ANCHOR_TIMEOUT_MS,
    });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, result: upstreamErrorResult(res.status, body) };
    }
    const outcome = anchorFromFacetsBody(body);
    if (!outcome.anchor) {
      return {
        ok: false,
        result: declaredRefusalResult(
          "near_center_absent",
          "No centre point on file for that parcel to search a radius around.",
          { parcelNodeId: query, anchorRead: outcome.anchorRead },
        ),
      };
    }
    return { ok: true, lat: outcome.anchor.lat, lng: outcome.anchor.lon };
  }

  const res = await cortexFetch(config, "/api/brokerage/v1/place/resolve", {
    method: "POST",
    userId,
    body: JSON.stringify({ address: query }),
  });
  const body = await res.text();
  if (!res.ok) {
    return { ok: false, result: upstreamErrorResult(res.status, body) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, result: upstreamErrorResult(res.status, body) };
  }
  const geocode =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).geocode
      : undefined;
  const point =
    geocode && typeof geocode === "object" && !Array.isArray(geocode)
      ? (geocode as Record<string, unknown>)
      : undefined;
  const lat = point?.lat;
  const lng = point?.lng;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    // place/resolve answered 200 with a body this tool cannot read as a
    // coordinate. Declared as an upstream problem (H1), not fabricated as
    // a near-specific refusal: resolve itself made no refusal claim here.
    return { ok: false, result: upstreamErrorResult(res.status, body) };
  }
  return { ok: true, lat, lng };
}

function inputSchemaFor(name: SmartsiteToolName) {
  switch (name) {
    case "find_parcels":
      // P-106. countyFips and filters are OPTIONAL at the schema and required
      // in the handler, on purpose and for the same reason find_parcel's three
      // modes are: a caller that omits the bound gets a DECLARED refusal naming
      // the problem, not a raw zod validation error. "No geographic bound is
      // refused" is an acceptance item, and a schema-level rejection would make
      // constraint_bound_missing unreachable through this tool.
      return z
        .object({
          countyFips: z
            .string()
            .regex(/^\d{5}$/)
            .optional(),
          filters: z.array(FIND_PARCELS_FILTER).optional(),
          cap: z.number().int().min(1).max(FIND_PARCELS_CAP_MAX).optional(),
          query: z.string().min(1).optional(),
        })
        .strict();
    case "find_parcel":
      // P-91 v3 Q1. query, near, and street are three alternate modes on
      // one tool; exactly one is required, enforced in the handler (not
      // here via .refine()) so a caller gets a declared refusal naming the
      // problem instead of a raw zod validation error. radiusFt carries no
      // local bound: that ceiling is exactly what radius_exceeds_max
      // exists to refuse, and pre-validating it here would make that
      // refusal code unreachable through this tool.
      return z
        .object({
          query: z.string().min(1).optional(),
          near: z
            .object({
              query: z.string().min(1),
              radiusFt: z.number(),
              cap: z.number().int().min(1).max(FIND_PARCEL_NEAR_CAP_MAX).optional(),
            })
            .strict()
            .optional(),
          street: z
            .object({
              query: z.string().min(1),
              cap: z.number().int().min(1).max(FIND_PARCEL_STREET_CAP_MAX).optional(),
              countyFips: z
                .string()
                .regex(/^\d{5}$/)
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict();
    case "list_my_properties":
      return z.object({}).passthrough();
    case "create_screen":
      return z
        .object({
          name: z.string().optional(),
          queries: z.array(z.string()),
          source: z.enum(["pasted"]),
        })
        .strict();
    case "add_to_screen":
      return z
        .object({
          screenId: z.string().min(1),
          parcelNodeId: z.string().min(1),
          source: z.enum(SCREEN_ROW_SOURCES),
        })
        .strict();
    case "list_screens":
      return z
        .object({
          screenId: z.string().min(1).optional(),
        })
        .strict();
    case "save_property":
      return z
        .object({
          parcelNodeId: z.string().min(1),
          status: z.enum(CRM_STATUSES).optional(),
          note: z.string().optional(),
        })
        .strict();
    case "set_property_status":
      return z
        .object({
          parcelNodeId: z.string().min(1),
          status: z.enum(CRM_STATUSES),
        })
        .strict();
    case "check_request":
      return z.object({ jobId: z.string().min(1) });
    case "list_purchased_records":
      return z.object({ parcelNodeId: z.string().min(1) }).strict();
    case "read_purchased_record":
      return z
        .object({
          parcelNodeId: z.string().min(1),
          artifactId: z.string().min(1),
        })
        .strict();
    case "ask_the_map":
      return askTheMapInputSchema();
    case "export_instrument":
      return z.object({
        parcelNodeId: z.string().min(1),
        kind: z.enum(["brief", "siteplan", "terrain", "dossier"]),
      });
    case "get_smart_site":
      return z.object({
        parcelNodeId: z.union([
          z.string().min(1),
          z.array(z.string().min(1)).min(1).max(SMARTSITE_BATCH_CAP),
        ]),
        depth: z.enum(GET_SMART_SITE_DEPTHS).optional(),
      });
    default:
      return z.object({ parcelNodeId: z.string().min(1) });
  }
}

/** P-91 item 1 plus Wave B writes. Reads keep readOnlyHint true. */
function annotationsFor(name: SmartsiteToolName) {
  if (name === "list_screens") {
    return { readOnlyHint: true };
  }
  if (
    name === "request_records" ||
    name === "create_screen" ||
    name === "add_to_screen" ||
    name === "save_property" ||
    name === "set_property_status"
  ) {
    return { readOnlyHint: false, destructiveHint: false };
  }
  return { readOnlyHint: true };
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * V2 (P-91 v3), payload half, standing-block leg. Every tool result gets
 * one extra content entry: the vocabulary lookup block, byte-identical on
 * every call. content[0] — the tool's own JSON — is never touched or
 * reordered, so every existing caller that reads content[0] sees exactly
 * what it saw before this wrapper existed; this is purely additive.
 */
function attachStandingVocabBlock(handler: ToolHandler): ToolHandler {
  return async (args) => {
    const result = await handler(args);
    return {
      ...result,
      content: [...result.content, STANDING_VOCAB_CONTENT_PART],
    };
  };
}

export function registerTools(server: McpServer): void {
  registerMcpApp(server);
  registerVocabularyResource(server);
  for (const tool of SMARTSITE_MCP_TOOLS) {
    const uiMeta = appMetaFor(tool.name);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputSchemaFor(tool.name),
        annotations: annotationsFor(tool.name),
        ...(uiMeta ? { _meta: uiMeta } : {}),
      },
      attachStandingVocabBlock(async (args: Record<string, unknown>) => {
        const auth = requireAuthContext();
        const entitlement = snapshotFromAuth(auth);

        if (tool.readiness === "blocked") {
          return {
            content: [
              {
                type: "text" as const,
                text: notReadyMessage(tool.name, tool.blockedReason ?? "blocked"),
              },
            ],
            isError: true,
          };
        }

        switch (tool.name) {
          case "find_parcels": {
            const { countyFips, filters, cap, query } = args as {
              countyFips?: string;
              filters?: unknown[];
              cap?: number;
              query?: string;
            };
            // Both bound checks are DECLARED refusals rather than schema
            // rejections, so a caller that omits either gets a reason token
            // and a sentence instead of a zod dump. Refusing here also keeps
            // a bound-less call off the wire entirely.
            if (!countyFips) {
              return declaredRefusalResult(
                "constraint_bound_missing",
                "A county is required. Give countyFips; there is no statewide constraint search.",
              );
            }
            if (!filters || filters.length === 0) {
              return declaredRefusalResult(
                "constraint_filters_missing",
                "At least one filter is required. A county with no filter is not a search.",
              );
            }
            return withCortex(async (config) => {
              const qs = new URLSearchParams({
                countyFips,
                filters: JSON.stringify(filters),
              });
              if (cap !== undefined) qs.set("cap", String(cap));
              if (query !== undefined) qs.set("q", query);
              const res = await cortexFetch(
                config,
                `/api/brokerage/v1/place/constraint-search?${qs.toString()}`,
                { userId: auth.userId },
              );
              const body = await res.text();
              if (!res.ok) {
                if (res.status === 422) {
                  const refusal = declarePlaceSearchRefusal(body);
                  if (refusal) {
                    return {
                      content: [
                        { type: "text" as const, text: JSON.stringify(refusal) },
                      ],
                      isError: true,
                    };
                  }
                }
                return upstreamErrorResult(res.status, body);
              }
              // 200: matched, excluded, notEvaluated, countingRule,
              // unmeasuredPctByRail and projection pass through VERBATIM. All
              // three sets are fields cortex already put on the wire, and this
              // tool must not strip, merge, or reorder any of them: a response
              // carrying only `matched` is the defect this card exists to
              // prevent.
              return {
                content: [{ type: "text" as const, text: body }],
                isError: false,
              };
            });
          }
          case "find_parcel": {
            const { query, near, street } = args as {
              query?: string;
              near?: { query: string; radiusFt: number; cap?: number };
              street?: { query: string; cap?: number; countyFips?: string };
            };
            const modesGiven = [query, near, street].filter(
              (v) => v !== undefined,
            ).length;
            if (modesGiven === 0) {
              return declaredRefusalResult(
                "find_parcel_mode_missing",
                "Provide one of query, near, or street.",
              );
            }
            if (modesGiven > 1) {
              return declaredRefusalResult(
                "find_parcel_mode_ambiguous",
                "Provide exactly one of query, near, or street, not more than one.",
              );
            }

            if (near !== undefined) {
              return withCortex(async (config) => {
                const center = await resolveNearCenterPoint(
                  config,
                  near.query,
                  auth.userId,
                );
                if (!center.ok) return center.result;
                const qs = new URLSearchParams({
                  lat: String(center.lat),
                  lng: String(center.lng),
                  radiusFt: String(near.radiusFt),
                });
                if (near.cap !== undefined) qs.set("cap", String(near.cap));
                const res = await cortexFetch(
                  config,
                  `/api/brokerage/v1/place/radius-search?${qs.toString()}`,
                  { userId: auth.userId },
                );
                const body = await res.text();
                if (!res.ok) {
                  if (res.status === 422) {
                    const refusal = declarePlaceSearchRefusal(body);
                    if (refusal) {
                      return {
                        content: [
                          { type: "text" as const, text: JSON.stringify(refusal) },
                        ],
                        isError: true,
                      };
                    }
                  }
                  return upstreamErrorResult(res.status, body);
                }
                // 200: cap, received, truncated, radiusFt, hits pass through
                // verbatim. Truncation is a field cortex already puts on
                // the wire; this tool must not strip it.
                return {
                  content: [{ type: "text" as const, text: body }],
                  isError: false,
                };
              });
            }

            if (street !== undefined) {
              return withCortex(async (config) => {
                const qs = new URLSearchParams({ q: street.query });
                if (street.cap !== undefined) qs.set("cap", String(street.cap));
                if (street.countyFips !== undefined) {
                  qs.set("countyFips", street.countyFips);
                }
                const res = await cortexFetch(
                  config,
                  `/api/brokerage/v1/place/street-search?${qs.toString()}`,
                  { userId: auth.userId },
                );
                const body = await res.text();
                if (!res.ok) {
                  if (res.status === 422) {
                    const refusal = declarePlaceSearchRefusal(body);
                    if (refusal) {
                      return {
                        content: [
                          { type: "text" as const, text: JSON.stringify(refusal) },
                        ],
                        isError: true,
                      };
                    }
                  }
                  return upstreamErrorResult(res.status, body);
                }
                // 200: cap, received, truncated, hits pass through verbatim.
                return {
                  content: [{ type: "text" as const, text: body }],
                  isError: false,
                };
              });
            }

            if (typeof query !== "string") {
              // Unreachable given the modesGiven checks above (near and
              // street are both undefined on this path), kept so `query`
              // is narrowed to `string` below without a non-null assertion.
              return declaredRefusalResult(
                "find_parcel_mode_missing",
                "Provide one of query, near, or street.",
              );
            }
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/brokerage/v1/place/situs-search?q=${encodeURIComponent(query)}`,
                { userId: auth.userId },
              );
              const body = await res.text();
              if (!res.ok) return upstreamErrorResult(res.status, body);
              return {
                content: [
                  { type: "text" as const, text: splitFindParcelHits(body) },
                ],
                isError: false,
              };
            });
          }
          case "get_smart_site": {
            const { parcelNodeId, depth } = args as {
              parcelNodeId: string | string[];
              depth?: (typeof GET_SMART_SITE_DEPTHS)[number];
            };
            if (depth === "hop1" || depth === "subgraph") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "not_implemented",
                      reason: "depth_not_implemented",
                      depth,
                    }),
                  },
                ],
                isError: true,
              };
            }
            const ids = Array.isArray(parcelNodeId)
              ? parcelNodeId
              : [parcelNodeId];
            // Published defaults: an array reads at stub, one id at node.
            const effectiveDepth: ImplementedDepth =
              depth ?? (Array.isArray(parcelNodeId) ? "stub" : "node");
            const cap = batchCapFor(effectiveDepth);
            if (Array.isArray(parcelNodeId) && ids.length > cap) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "refused",
                      reason: "parcel_batch_cap",
                      cap,
                      received: ids.length,
                      depth: effectiveDepth,
                    }),
                  },
                ],
                isError: true,
              };
            }
            const briefBody: Record<string, unknown> = { parcelNodeId };
            if (depth) briefBody.depth = depth;
            // M-1: a single-id node read carries one anchor. M-4: a node-depth
            // ARRAY carries one anchor per parcel, bounded by
            // ANCHOR_BATCH_READ_CAP and declared when it truncates, because a
            // shared canvas cannot place two rings without two coordinates.
            // A stub row still has no draw for an anchor to hold, at any arity.
            const readsAnchor =
              !Array.isArray(parcelNodeId) && effectiveDepth === "node";
            const readsAnchorBatch =
              Array.isArray(parcelNodeId) && effectiveDepth === "node";
            return withCortex(async (config) => {
              const briefPromise = cortexFetch(
                config,
                `/api/property-explorer/v1/research/brief`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(briefBody),
                },
              );
              // Both anchor reads are issued WITH the brief, never after it, and
              // joined once the brief has landed, so the panel waits
              // max(brief, anchors) and the batch's twelve run concurrently
              // rather than in series. Neither rejects, so both are safe to
              // leave unawaited on the non-OK returns below.
              //
              // The single top-level outcome: a stub row carries no draw at any
              // arity, so a stub read declares that and reads nothing. A node
              // ARRAY never reaches this value, because the batch branch below
              // is taken instead and attaches per parcel.
              const anchorPromise: Promise<AnchorOutcome> = readsAnchor
                ? readParcelAnchor(config, parcelNodeId as string)
                : Promise.resolve(skippedAnchorForStub());
              const batchPromise: Promise<BatchAnchorOutcome | null> =
                readsAnchorBatch
                  ? readParcelAnchorsForBatch(config, ids)
                  : Promise.resolve(null);
              const res = await briefPromise;
              const body = await res.text();
              if (!res.ok) {
                // Wire contract 4.1: a declared miss or refusal is a result
                // the host forwards to the panel; anything else is an error.
                const declared = mapGetSmartSiteNonOk(res.status, body, ids);
                if (declared === null) {
                  return upstreamErrorResult(res.status, body);
                }
                return {
                  content: [{ type: "text" as const, text: declared }],
                  isError: false,
                };
              }
              const mode =
                Array.isArray(parcelNodeId) || depth === "stub"
                  ? "stub-or-batch"
                  : "single-node";
              const normalized = normalizeGetSmartSiteResponseText(body, mode);
              const batchOutcome = await batchPromise;
              const anchored = batchOutcome
                ? attachBatchAnchorsToResponseText(normalized, batchOutcome)
                : attachAnchorToResponseText(normalized, await anchorPromise);
              return {
                content: [{ type: "text" as const, text: anchored }],
                isError: false,
              };
            });
          }
          case "list_my_properties": {
            const raw = args as Record<string, unknown>;
            if (Object.prototype.hasOwnProperty.call(raw, "screenId")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({
                      status: "refused",
                      reason: "screen_id_not_accepted",
                      error: "screen_id_not_accepted",
                    }),
                  },
                ],
                isError: true,
              };
            }
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties`,
                { userId: auth.userId },
              );
              const body = await res.text();
              if (!res.ok) return upstreamErrorResult(res.status, body);
              let parsed: unknown;
              try {
                parsed = JSON.parse(body);
              } catch {
                // A 200 that is not JSON is still an error this server
                // declares (H1), carrying the status it actually saw.
                return upstreamErrorResult(res.status, body);
              }
              const summary = stripSavedPropertiesForExternal(parsed);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(summary) },
                ],
                isError: false,
              };
            });
          }
          case "run_report": {
            const { parcelNodeId } = args as { parcelNodeId: string };
            if (!canRunDeepReport(entitlement)) {
              return upgradeRequiredResult(refuseDeepReport(entitlement));
            }
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/research/brief`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ parcelNodeId }),
                },
              );
              const body = await res.text();
              if (!res.ok) {
                // No read happened, so no read stamp (reportKind /
                // reportReadMode / async). The upstream body travels under
                // its own keys as a declared error (H1).
                return upstreamErrorResult(res.status, body);
              }
              const envelope = buildRunReportEnvelope(parcelNodeId, body);
              return {
                content: [
                  { type: "text" as const, text: JSON.stringify(envelope) },
                ],
                isError: false,
              };
            });
          }
          case "list_purchased_records": {
            const { parcelNodeId } = args as { parcelNodeId: string };
            return listPurchasedRecords(entitlement, auth.userId, {
              parcelNodeId,
            });
          }
          case "read_purchased_record": {
            const { parcelNodeId, artifactId } = args as {
              parcelNodeId: string;
              artifactId: string;
            };
            return readPurchasedRecord(entitlement, auth.userId, {
              parcelNodeId,
              artifactId,
            });
          }
          // P-110: re-armed. The three rulings P-109 left open are closed
          // (A-096): there is no upstream "brief" export kind, so it is
          // refused before any config load or network call, never proxied;
          // the upstream shape is two-hop refresh-then-download, per format,
          // now spoken as real MCP JSON-RPC (POST /mcp) instead of the
          // never-existent POST /tools/export_instrument REST route; and the
          // upstream tools' SDK metering is absorbed on Legacy Group ATX's
          // side via this server's own HAUSKA_MCP_SERVICE_KEY (operator
          // ruling, not a new billing mechanism — see export-instrument.ts).
          // The Studio gate is unchanged from the pre-P-109 shape.
          case "export_instrument": {
            const { parcelNodeId, kind } = args as {
              parcelNodeId: string;
              kind: "brief" | "siteplan" | "terrain" | "dossier";
            };
            if (kind === "brief") {
              return exportKindNotAvailableResult();
            }
            if (isStudioExportKind(kind) && !canRunStudioReport(entitlement)) {
              return upgradeRequiredResult(refuseStudioReport(entitlement));
            }
            return ensureDeclaredError(
              await executeExportInstrument({ parcelNodeId, kind }),
            );
          }
          case "create_screen": {
            const body = args as {
              name?: string;
              queries: string[];
              source: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/screens`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(body),
                },
              );
              const text = await res.text();
              if (!res.ok) {
                // OPS-16 A-101: screens have no local Studio predicate (the
                // route is the sole gate — see mapScreensGateNonOk). A 402
                // shaped as its own refusal reshapes into the same declared
                // upgrade_required envelope export_instrument's local gate
                // returns; anything else stays the generic upstream error.
                const upgrade = mapScreensGateNonOk(res.status, text);
                if (upgrade) return upgradeRequiredResult(upgrade);
                return upstreamErrorResult(res.status, text);
              }
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
              };
            });
          }
          case "add_to_screen": {
            const { screenId, parcelNodeId, source } = args as {
              screenId: string;
              parcelNodeId: string;
              source: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/screens/${encodeURIComponent(screenId)}/rows`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ parcelNodeId, source }),
                },
              );
              const text = await res.text();
              if (!res.ok) {
                // Same reshape as create_screen; see the comment there.
                const upgrade = mapScreensGateNonOk(res.status, text);
                if (upgrade) return upgradeRequiredResult(upgrade);
                return upstreamErrorResult(res.status, text);
              }
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
              };
            });
          }
          case "list_screens": {
            const { screenId } = args as { screenId?: string };
            const path = screenId
              ? `/api/property-explorer/v1/screens/${encodeURIComponent(screenId)}`
              : `/api/property-explorer/v1/screens`;
            return withCortex(async (config) => {
              const res = await cortexFetch(config, path, {
                userId: auth.userId,
              });
              const text = await res.text();
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
              };
            });
          }
          case "save_property": {
            const { parcelNodeId, status, note } = args as {
              parcelNodeId: string;
              status?: string;
              note?: string;
            };
            const body: Record<string, string> = {};
            if (status !== undefined) body.status = status;
            if (note !== undefined) body.note = note;
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties/${encodeURIComponent(parcelNodeId)}/save`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify(body),
                },
              );
              const text = await res.text();
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
              };
            });
          }
          case "set_property_status": {
            const { parcelNodeId, status } = args as {
              parcelNodeId: string;
              status: string;
            };
            return withCortex(async (config) => {
              const res = await cortexFetch(
                config,
                `/api/property-explorer/v1/saved-properties/${encodeURIComponent(parcelNodeId)}/status`,
                {
                  method: "POST",
                  userId: auth.userId,
                  body: JSON.stringify({ status }),
                },
              );
              const text = await res.text();
              if (!res.ok) return upstreamErrorResult(res.status, text);
              return {
                content: [{ type: "text" as const, text }],
                isError: false,
              };
            });
          }
          // ask_the_map has no handler while readiness is "blocked" (P-91
          // item 34): the blocked branch above answers not_ready before the
          // switch, the same as the records pair. Re-arming it means a case
          // here that builds the chat subject from the bake and keeps
          // sanitizeAskTheMapErrorBody on the cortex error path.
        }
      }),
    );
  }
}
