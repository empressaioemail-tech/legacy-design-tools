/**
 * P-85 WDLL item 14 — versioned recipe selector probes for daily portal canary.
 *
 * Each probe names the recipe version it guards and the selectors that must still
 * resolve on the portal entry surface. Drift (zero selectors match) marks the
 * portal lookup-failed until the next passing canary run.
 */

import { TERMS_ACCEPT_SELECTORS, tryClickFirst } from "./browserSelectors.js";
import { P85_PORTALS, type P85PortalConfig } from "./p85Portals.js";
import type { RecordsRecipeBrowser } from "./types.js";

export interface RecipeCanaryProbe {
  probeId: string;
  recipeVersion: string;
  portalIds: readonly string[];
  /** At least one selector must still click successfully after entry navigation. */
  driftSelectors: readonly string[];
}

/** Deliberately broken selector for canary failure fixtures (unit tests only). */
export const BROKEN_CANARY_SELECTOR_FIXTURE =
  "#p85-canary-deliberately-broken-selector-never-exists";

const TYLER_ACCEPT_SELECTORS = [
  'input[type="submit"][value*="Accept" i]',
  'button:has-text("I Accept")',
  'button:has-text("Accept")',
  'a:has-text("Accept")',
  "#acceptDisclaimer",
  "#btnAccept",
] as const;

const PUBLICSEARCH_TERMS_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("I Agree")',
  'a:has-text("Accept")',
  'input[type="submit"][value*="Accept" i]',
] as const;

const AUMENTUM_TERMS_SELECTORS = TERMS_ACCEPT_SELECTORS;

/** Registry keyed by probeId; portal lookup is many-to-one. */
export const RECIPE_CANARY_PROBES: readonly RecipeCanaryProbe[] = [
  {
    probeId: "aumentum-index-v2",
    recipeVersion: "p85-aumentum-index-search-v2",
    portalIds: ["bastrop-aumentum", "travis-tccsearch"],
    driftSelectors: AUMENTUM_TERMS_SELECTORS,
  },
  {
    probeId: "tyler-self-service-v2",
    recipeVersion: "p85-tyler-self-service-v2",
    portalIds: ["williamson-tylerhost", "hays-erss"],
    driftSelectors: TYLER_ACCEPT_SELECTORS,
  },
  {
    probeId: "publicsearch-v1",
    recipeVersion: "p85-publicsearch-v1",
    portalIds: ["williamson-publicsearch"],
    driftSelectors: PUBLICSEARCH_TERMS_SELECTORS,
  },
  {
    probeId: "reachability-scaffold-v0",
    recipeVersion: "p85-reachability-scaffold-v0",
    portalIds: ["caldwell-clerk-web", "mclennan-online-records"],
    driftSelectors: ['a[href*="clerk" i]', "body"],
  },
] as const;

const PROBE_BY_PORTAL = new Map<string, RecipeCanaryProbe>(
  RECIPE_CANARY_PROBES.flatMap((probe) =>
    probe.portalIds.map((portalId) => [portalId, probe] as const),
  ),
);

export function canaryProbeForPortal(portalId: string): RecipeCanaryProbe | undefined {
  return PROBE_BY_PORTAL.get(portalId);
}

export function portalConfigForCanary(portalId: string): P85PortalConfig | undefined {
  return P85_PORTALS.find((p) => p.portalId === portalId);
}

export type RecipeCanaryCheckResult =
  | { ok: true; probeId: string; recipeVersion: string }
  | {
      ok: false;
      probeId: string;
      recipeVersion: string;
      reason: string;
    };

export interface RecipeCanaryCheckOptions {
  /** Test seam — override drift selectors (e.g. broken fixture). */
  driftSelectors?: readonly string[];
}

/**
 * Navigate to portal entry and verify versioned selectors still resolve.
 * Navigation failure or zero selector matches is a canary fail (lookup-failed).
 */
export async function checkRecipeCanarySelectors(
  portalId: string,
  browser: RecordsRecipeBrowser,
  options?: RecipeCanaryCheckOptions,
): Promise<RecipeCanaryCheckResult> {
  const portal = portalConfigForCanary(portalId);
  if (!portal) {
    return {
      ok: false,
      probeId: "unknown",
      recipeVersion: "unknown",
      reason: `No P-85 portal config for portalId=${portalId}`,
    };
  }

  const probe = canaryProbeForPortal(portalId);
  const recipeVersion = probe?.recipeVersion ?? portal.recipeVersion;
  const probeId = probe?.probeId ?? "navigation-only";

  const nav = await browser.goto(portal.entryUrl);
  if (!nav.ok) {
    return {
      ok: false,
      probeId,
      recipeVersion,
      reason:
        nav.errorMessage ??
        (nav.status != null
          ? `entry navigation HTTP ${nav.status} for ${portal.entryUrl}`
          : `entry navigation failed for ${portal.entryUrl}`),
    };
  }

  const selectors =
    options?.driftSelectors ??
    probe?.driftSelectors ??
    (["body"] as readonly string[]);

  const matched = await tryClickFirst(browser, selectors);
  if (!matched) {
    const selectorSample =
      selectors.length <= 3
        ? selectors.join(", ")
        : `${selectors.slice(0, 2).join(", ")}, … (+${selectors.length - 2} more)`;
    return {
      ok: false,
      probeId,
      recipeVersion,
      reason: `canary selector drift: none of ${selectors.length} probe selector(s) matched on ${portalId} (${portal.entryUrl}); tried: ${selectorSample}`,
    };
  }

  return { ok: true, probeId, recipeVersion };
}
