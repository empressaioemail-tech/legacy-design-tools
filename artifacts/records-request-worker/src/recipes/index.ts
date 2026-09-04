/**
 * P-85 item 5 — recipe registry and portal resolution.
 */

import {
  P85_DEFAULT_PORTAL_BY_COUNTY,
  P85_PORTALS,
  portalConfigById,
  type P85PortalConfig,
} from "./p85Portals.js";
import { runAumentumIndexSearch } from "./aumentumIndexSearch.js";
import { runPublicsearchRecipe } from "./publicsearchSearch.js";
import { runPortalReachabilityRecipe } from "./portalReachability.js";
import { runCountyGovernmentRecordsSearch } from "./countyGovernmentRecordsSearch.js";
import {
  runTylerSelfServiceSearch,
  tylerSurfaceFromPortal,
} from "./tylerSelfServiceSearch.js";
import type {
  RecordsRecipeBrowser,
  RecordsRecipeContext,
  RecordsRecipeDefinition,
  RecordsRecipeResult,
} from "./types.js";
import {
  fetchRobotsTxt,
  robotsTxtScopeRecord,
} from "../robotsTxt.js";

const AUMENTUM_SEARCH_PORTAL_IDS = new Set([
  "bastrop-aumentum",
  "travis-tccsearch",
]);
const TYLER_SEARCH_PORTAL_IDS = new Set([
  "williamson-tylerhost",
  "hays-erss",
  // P-113: McLennan is the same Tyler self-service DOCSEARCH product as
  // Hays, verified live 2026-09-03 (reachable headless, unlike Williamson
  // TylerHost's 403-to-bots).
  "mclennan-online-records",
]);
const PUBLICSEARCH_PORTAL_IDS = new Set(["williamson-publicsearch"]);
// P-113: Caldwell's real vendor (verified live 2026-09-03) requires login
// before any search — its own recipe fails closed to needs-human rather than
// falling through to the bare reachability scaffold.
const COUNTY_GOV_RECORDS_PORTAL_IDS = new Set(["caldwell-clerk-web"]);

function recipeForPortalConfig(
  portal: P85PortalConfig,
): RecordsRecipeDefinition {
  return {
    portalId: portal.portalId,
    countyFips: portal.countyFips,
    recipeVersion: portal.recipeVersion,
    run: (ctx, browser) => runRecipeForPortalConfig(ctx, portal, browser),
  };
}

async function runRecipeForPortalConfig(
  ctx: RecordsRecipeContext,
  portal: P85PortalConfig,
  browser: RecordsRecipeBrowser,
): Promise<RecordsRecipeResult> {
  if (TYLER_SEARCH_PORTAL_IDS.has(portal.portalId)) {
    return runTylerSelfServiceSearch(
      ctx,
      tylerSurfaceFromPortal(portal),
      browser,
    );
  }
  if (AUMENTUM_SEARCH_PORTAL_IDS.has(portal.portalId)) {
    return runAumentumIndexSearch(ctx, portal, browser);
  }
  if (PUBLICSEARCH_PORTAL_IDS.has(portal.portalId)) {
    return runPublicsearchRecipe(ctx, portal, browser);
  }
  if (COUNTY_GOV_RECORDS_PORTAL_IDS.has(portal.portalId)) {
    return runCountyGovernmentRecordsSearch(ctx, portal, browser);
  }
  return runPortalReachabilityRecipe(ctx, portal, browser);
}

const REGISTRY: readonly RecordsRecipeDefinition[] = P85_PORTALS.map(
  recipeForPortalConfig,
);

export function listRegisteredRecipes(): readonly RecordsRecipeDefinition[] {
  return REGISTRY;
}

export function recipeForPortal(portalId: string): RecordsRecipeDefinition | undefined {
  return REGISTRY.find((r) => r.portalId === portalId);
}

/**
 * Resolve portal id from job payload or county default.
 * All six P-85 counties have a default portal; explicit portalId wins.
 */
export function resolvePortalIdForJob(
  countyFips: string,
  requestPayload: Record<string, unknown> | null,
): string | null {
  const fromPayload = requestPayload?.portalId;
  if (typeof fromPayload === "string" && fromPayload.trim()) {
    return fromPayload.trim();
  }
  return P85_DEFAULT_PORTAL_BY_COUNTY[countyFips] ?? null;
}

function attachRobotsTxtToResult(
  result: RecordsRecipeResult,
  robotsTxt: Record<string, unknown>,
): RecordsRecipeResult {
  return {
    ...result,
    scopeSearched: {
      ...(result.scopeSearched ?? {}),
      robotsTxt,
    },
  };
}

export async function runRecipeForJob(
  ctx: RecordsRecipeContext,
  browser: RecordsRecipeBrowser,
  options?: {
    fetchRobotsTxtFn?: typeof fetchRobotsTxt;
  },
): Promise<RecordsRecipeResult> {
  const portal = portalConfigById(ctx.portalId);
  const recipe = recipeForPortal(ctx.portalId);
  if (!portal || !recipe) {
    return {
      status: "failed",
      errorCode: "recipe-not-registered",
      errorMessage: `No records recipe registered for portalId=${ctx.portalId}`,
    };
  }
  if (recipe.countyFips !== ctx.countyFips) {
    return {
      status: "failed",
      errorCode: "recipe-county-mismatch",
      errorMessage: `Portal ${ctx.portalId} is not registered for countyFips=${ctx.countyFips}`,
    };
  }

  const fetchRobots = options?.fetchRobotsTxtFn ?? fetchRobotsTxt;
  const robotsTxtResult = await fetchRobots(portal.entryUrl);
  const robotsTxtRecord = robotsTxtScopeRecord(robotsTxtResult);

  const recipeResult = await recipe.run(ctx, browser);
  return attachRobotsTxtToResult(recipeResult, robotsTxtRecord);
}

export type { RecordsRecipeContext, RecordsRecipeResult, RecordsRecipeBrowser };
