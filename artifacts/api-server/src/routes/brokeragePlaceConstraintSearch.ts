/**
 *   GET /api/brokerage/v1/place/constraint-search
 *     ?countyFips=48021&filters=<json>&cap=50
 *
 * Ask a question ACROSS parcels. `radius-search` and `street-search` bound a
 * set geometrically; this one bounds it by what you can DO with the land.
 *
 * The answer is THREE SETS, never one: matched, excluded, and not-evaluated
 * with the rail named. Truncation is a field, the way `near` and `street`
 * already report it. Every refusal is DECLARED, with a reason token and a
 * 422 `serve_refused`, never an error.
 *
 * Mounted under the brokerage service gate, next to the other two searches.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import pg from "pg";
import { gtmErrorBody } from "../lib/gtmErrorClass";
import {
  CONSTRAINT_SEARCH_MAX_CAP,
  runConstraintSearch,
  unmeasuredRefuseAbovePctFromEnv,
  type ConstraintFilter,
  type ConstraintSearchQueryable,
} from "../lib/parcelConstraintSearch";

export const brokeragePlaceConstraintSearchRouter: IRouter = Router();

/**
 * The filter grammar on the wire. Deliberately a closed discriminated union
 * rather than a free-form object: an unrecognised op fails at the boundary
 * with a named reason instead of reaching the SQL builder. `strict()` on each
 * member means an extra key is a rejection, not a silently ignored field.
 */
const FilterSchema = z.union([
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

const QUERY = z.object({
  countyFips: z.string().trim().regex(/^\d{5}$/).optional(),
  filters: z.string().min(1),
  cap: z.coerce.number().int().min(1).max(CONSTRAINT_SEARCH_MAX_CAP).optional(),
  /** Echoed back only so a single-address query can be refused by name. */
  q: z.string().trim().max(256).optional(),
});

let sharedPool: pg.Pool | null = null;
let injectedQueryable: ConstraintSearchQueryable | null | undefined;

/** Test seam. `null` means the store is not configured. */
export function setConstraintSearchQueryableForTests(
  queryable: ConstraintSearchQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetConstraintSearchQueryableForTests(): void {
  injectedQueryable = undefined;
}

/**
 * The projection lives in the DEPLOYMENT store next to the bake it is
 * projected from, so this reads `DATABASE_URL`, which in api-server means
 * deployment. It does NOT read `ATOMS_DATABASE_URL`: the flood and
 * special-district atom reads happen in the BUILD, not in the search, which is
 * the whole point of projecting once instead of per query.
 */
function queryableFromEnv(): ConstraintSearchQueryable | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
  }
  return sharedPool;
}

function resolveQueryable(): ConstraintSearchQueryable | null {
  if (injectedQueryable !== undefined) return injectedQueryable;
  return queryableFromEnv();
}

brokeragePlaceConstraintSearchRouter.get(
  "/constraint-search",
  async (req: Request, res: Response) => {
    const parsed = QUERY.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          `filters is required as a JSON array; countyFips is a 5-digit FIPS; cap is optional (1-${CONSTRAINT_SEARCH_MAX_CAP})`,
        ),
      );
      return;
    }

    let filtersRaw: unknown;
    try {
      filtersRaw = JSON.parse(parsed.data.filters);
    } catch {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          "filters must be a JSON array of {rail, op, ...} objects",
        ),
      );
      return;
    }
    const filterList = z.array(FilterSchema).safeParse(filtersRaw);
    if (!filterList.success) {
      res.status(400).json(
        gtmErrorBody(
          "validation_error",
          "invalid_request",
          "each filter must be {rail, op:gte|lte|eq, number} | {rail, op:eq, text} | {rail, op:in, texts[]} | {rail, op:absent} | {rail, op:is_true|is_false}",
        ),
      );
      return;
    }

    const db = resolveQueryable();
    if (!db) {
      // Not a refusal ABOUT the county: the store this route reads is not
      // configured, which is our problem, not an answer about parcels.
      res.status(503).json(
        gtmErrorBody(
          "unknown",
          "store_not_configured",
          "The constraint index store is not configured on this deployment.",
        ),
      );
      return;
    }

    const result = await runConstraintSearch({
      countyFips: parsed.data.countyFips ?? "",
      filters: filterList.data as ConstraintFilter[],
      cap: parsed.data.cap,
      query: parsed.data.q,
      db,
      unmeasuredRefuseAbovePct: unmeasuredRefuseAbovePctFromEnv(),
    });

    if ("refused" in result) {
      // `detail` is nested under its own key rather than spread at the top
      // level, because the MCP tool passes it through verbatim and a refusal
      // that names a threshold while hiding the number it was measured
      // against is an assertion, not a determination.
      res
        .status(422)
        .json(
          gtmErrorBody(
            "serve_refused",
            result.code,
            result.reason,
            result.detail ? { detail: result.detail } : undefined,
          ),
        );
      return;
    }
    res.json(result);
  },
);
