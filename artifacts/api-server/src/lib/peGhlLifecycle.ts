/**
 * Apply a Smart Site lifecycle event to GoHighLevel: upsert the contact,
 * write ss_* tags and SS fields, move the Self Serve opportunity forward
 * only.
 *
 * Never writes `source-*` or `tier-*`. Never points a call sequence or
 * booking at the contact. A send failure is returned, never thrown, so the
 * caller can fail-open for the user.
 */

import { logger } from "./logger";
import { resolveSourceTag, type CampaignSet } from "./peCampaignSource";
import { assertLifecyclePayloadSafe } from "./peLifecycleDenylist";
import {
  GHL_API_BASE,
  GHL_REQUEST_TIMEOUT_MS,
  ghlConfigFromEnv,
  ghlHeaders,
  loadGhlCatalog,
  type GhlCatalog,
  type GhlConfig,
} from "./peGhlCatalog";
import {
  BILLING_TAGS,
  FIELD_NAMES,
  STAGE_TAGS,
  highestStage,
  stageForPlan,
  type LifecycleEventType,
  type LifecycleStage,
  type SsBilling,
  type SsPlan,
} from "./peLifecycleTypes";

type FetchLike = typeof fetch;

export type LifecycleApplyInput = {
  email: string;
  displayName?: string;
  event: LifecycleEventType;
  campaign?: string;
  savedLots?: number;
  shares?: number;
  lastActive?: string;
  plan?: SsPlan;
  billing?: SsBilling;
  /** Current stage already known (from a prior event). */
  currentStage?: LifecycleStage | null;
  value?: number;
  currency?: string;
};

export type LifecycleApplyResult =
  | {
      ok: true;
      contactId: string;
      stage: LifecycleStage;
      tags: string[];
      sourceTag: string | null;
    }
  | { ok: false; error: string; missing?: string[] };

const RETIRED_TAG_PREFIXES = ["source-", "tier-"] as const;

function customField(
  catalog: GhlCatalog,
  name: string,
  value: string | number,
): { id: string; field_value: string } {
  const id = catalog.fields[name];
  if (!id) throw new Error(`ghl_field_unresolved:${name}`);
  return { id, field_value: String(value) };
}

function sourceTagFor(input: LifecycleApplyInput): {
  tag: string | null;
  campaign: CampaignSet;
  unmapped: boolean;
} {
  if (input.event !== "e1_account_created") {
    return { tag: null, campaign: {}, unmapped: false };
  }
  const resolution = resolveSourceTag(input.campaign);
  if (resolution.kind === "unmapped") {
    return { tag: null, campaign: resolution.campaign, unmapped: true };
  }
  return {
    tag: resolution.tag,
    campaign: resolution.campaign,
    unmapped: false,
  };
}

function nextStage(input: LifecycleApplyInput): LifecycleStage {
  const current = input.currentStage ?? null;
  switch (input.event) {
    case "e1_account_created":
      return highestStage(current, "Explorer");
    case "e2_lot_saved":
    case "e6_last_active":
      return highestStage(current, current ?? "Explorer");
    case "e3_share_sent":
      return highestStage(current, "Sharer");
    case "e4_unlock_bought":
      return highestStage(current, "Unlock");
    case "e5_plan_started": {
      const planStage = input.plan ? stageForPlan(input.plan) : null;
      return planStage
        ? highestStage(current, planStage)
        : (current ?? "Explorer");
    }
  }
}

function tagsFor(
  stage: LifecycleStage,
  input: LifecycleApplyInput,
  sourceTag: string | null,
): string[] {
  const tags = [STAGE_TAGS[stage]];
  if (sourceTag) tags.push(sourceTag);
  if (input.billing === "monthly") tags.push(BILLING_TAGS.monthly);
  if (input.billing === "annual") tags.push(BILLING_TAGS.annual);
  for (const tag of tags) {
    for (const prefix of RETIRED_TAG_PREFIXES) {
      if (tag.startsWith(prefix)) {
        throw new Error(`retired_tag_refused:${tag}`);
      }
    }
  }
  return tags;
}

function fieldsFor(
  catalog: GhlCatalog,
  input: LifecycleApplyInput,
  campaign: CampaignSet,
): { id: string; field_value: string }[] {
  const fields: { id: string; field_value: string }[] = [];
  if (input.plan) {
    fields.push(customField(catalog, FIELD_NAMES.plan, input.plan));
  }
  if (input.billing) {
    fields.push(customField(catalog, FIELD_NAMES.billing, input.billing));
  }
  if (typeof input.savedLots === "number") {
    fields.push(customField(catalog, FIELD_NAMES.savedLots, input.savedLots));
  }
  if (typeof input.shares === "number") {
    fields.push(customField(catalog, FIELD_NAMES.shares, input.shares));
  }
  if (input.lastActive) {
    fields.push(customField(catalog, FIELD_NAMES.lastActive, input.lastActive));
  }
  if (input.event === "e1_account_created") {
    if (campaign.utm_source) {
      fields.push(customField(catalog, FIELD_NAMES.utmSource, campaign.utm_source));
    }
    if (campaign.utm_medium) {
      fields.push(customField(catalog, FIELD_NAMES.utmMedium, campaign.utm_medium));
    }
    if (campaign.utm_campaign) {
      fields.push(
        customField(catalog, FIELD_NAMES.utmCampaign, campaign.utm_campaign),
      );
    }
    if (campaign.utm_content) {
      fields.push(customField(catalog, FIELD_NAMES.utmContent, campaign.utm_content));
    }
  }
  return fields;
}

async function ghlJson(
  fetchImpl: FetchLike,
  config: GhlConfig,
  path: string,
  init: { method: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(`${GHL_API_BASE}${path}`, {
    method: init.method,
    headers: ghlHeaders(config.apiKey),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}

export async function applyLifecycleToGhl(
  input: LifecycleApplyInput,
  opts: { fetchImpl?: FetchLike; config?: GhlConfig | null } = {},
): Promise<LifecycleApplyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const config = opts.config === undefined ? ghlConfigFromEnv() : opts.config;
  if (!config) return { ok: false, error: "gohighlevel_not_configured" };

  const email = input.email.trim();
  if (!email) return { ok: false, error: "no_email" };

  const loaded = await loadGhlCatalog(config, fetchImpl);
  if (!loaded.ok) {
    logger.error(
      { error: loaded.error, missing: loaded.missing },
      "pe lifecycle: GHL catalog incomplete — refusing send rather than guessing ids",
    );
    return loaded;
  }
  const catalog = loaded.catalog;

  const source = sourceTagFor(input);
  if (source.unmapped) {
    logger.info(
      { campaign: source.campaign, email },
      "pe lifecycle: campaign arrived but matches no row of the source table; writing no source tag",
    );
  }

  const stage = nextStage(input);
  const tags = tagsFor(stage, input, source.tag);
  const customFields = fieldsFor(catalog, input, source.campaign);

  const upsertBody: Record<string, unknown> = {
    locationId: config.locationId,
    email,
    ...(input.displayName ? { name: input.displayName } : {}),
    tags,
    customFields,
  };
  assertLifecyclePayloadSafe(upsertBody);

  try {
    const upsert = await ghlJson(fetchImpl, config, "/contacts/upsert", {
      method: "POST",
      body: upsertBody,
    });
    if (!upsert.ok) {
      const message =
        typeof upsert.body["message"] === "string"
          ? upsert.body["message"]
          : `GHL HTTP ${upsert.status}`;
      return { ok: false, error: message };
    }
    const contact = upsert.body["contact"] as Record<string, unknown> | undefined;
    const contactId =
      typeof contact?.["id"] === "string" ? contact["id"] : "";
    if (!contactId) return { ok: false, error: "ghl_response_missing_contact_id" };

    const opportunityBody = {
      locationId: config.locationId,
      contactId,
      pipelineId: catalog.pipelineId,
      pipelineStageId: catalog.stages[stage],
      name: `Smart Site · ${email}`,
      status: "open",
    };
    assertLifecyclePayloadSafe(opportunityBody);
    const opp = await ghlJson(fetchImpl, config, "/opportunities/", {
      method: "POST",
      body: opportunityBody,
    });
    if (!opp.ok && opp.status !== 400) {
      // 400 often means an opportunity already exists; stage update is a
      // later hop. Contact write still landed.
      logger.info(
        { status: opp.status, contactId, stage },
        "pe lifecycle: opportunity create did not succeed; contact write stands",
      );
    }

    return { ok: true, contactId, stage, tags, sourceTag: source.tag };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? "ghl_request_timeout"
          : err.message
        : "unknown_error";
    return { ok: false, error: message };
  }
}
