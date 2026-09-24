/**
 * Resolve GoHighLevel pipeline, stage, tag and custom-field ids by name
 * from the live location. Fail loudly if any required name is missing —
 * never hardcode an id, never guess a substitute.
 *
 * P-413: "Resolve the pipeline, stage, tag and field ids by name from the
 * live location once and fail loudly if any is missing."
 */

import {
  FIELD_NAMES,
  PIPELINE_NAME,
  REQUIRED_FIELDS,
  REQUIRED_TAGS,
  STAGES,
  type LifecycleStage,
} from "./peLifecycleTypes";

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";
export const GHL_REQUEST_TIMEOUT_MS = 4000;

export type GhlConfig = { apiKey: string; locationId: string };

export type GhlCatalog = {
  pipelineId: string;
  stages: Record<LifecycleStage, string>;
  tags: Record<string, string>;
  fields: Record<string, string>;
};

export type GhlCatalogResult =
  | { ok: true; catalog: GhlCatalog }
  | { ok: false; error: string; missing: string[] };

type FetchLike = typeof fetch;

let cached: { key: string; catalog: GhlCatalog } | null = null;

export function resetGhlCatalogCache(): void {
  cached = null;
}

export function ghlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GhlConfig | null {
  const apiKey = env["GOHIGHLEVEL_API_KEY"]?.trim();
  const locationId = env["GOHIGHLEVEL_LOCATION_ID"]?.trim();
  if (!apiKey || !locationId) return null;
  return { apiKey, locationId };
}

export function ghlHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function ghlGet(
  fetchImpl: FetchLike,
  config: GhlConfig,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${GHL_API_BASE}${path}`, {
    method: "GET",
    headers: ghlHeaders(config.apiKey),
    signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof body["message"] === "string"
        ? body["message"]
        : `GHL HTTP ${res.status} on ${path}`;
    throw new Error(message);
  }
  return body;
}

function namedId(
  rows: unknown,
  name: string,
): string | null {
  if (!Array.isArray(rows)) return null;
  const want = name.toLowerCase();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const rowName =
      typeof rec["name"] === "string"
        ? rec["name"]
        : typeof rec["name"] === "number"
          ? String(rec["name"])
          : "";
    const id = typeof rec["id"] === "string" ? rec["id"] : "";
    if (id && rowName.toLowerCase() === want) return id;
  }
  return null;
}

export async function loadGhlCatalog(
  config: GhlConfig,
  fetchImpl: FetchLike = fetch,
): Promise<GhlCatalogResult> {
  const cacheKey = `${config.locationId}:${config.apiKey.slice(0, 8)}`;
  if (cached && cached.key === cacheKey) {
    return { ok: true, catalog: cached.catalog };
  }

  const missing: string[] = [];
  try {
    const [pipelinesBody, tagsBody, fieldsBody] = await Promise.all([
      ghlGet(
        fetchImpl,
        config,
        `/opportunities/pipelines?locationId=${encodeURIComponent(config.locationId)}`,
      ),
      ghlGet(
        fetchImpl,
        config,
        `/locations/${encodeURIComponent(config.locationId)}/tags`,
      ),
      ghlGet(
        fetchImpl,
        config,
        `/locations/${encodeURIComponent(config.locationId)}/customFields`,
      ),
    ]);

    const pipelines = Array.isArray(pipelinesBody["pipelines"])
      ? pipelinesBody["pipelines"]
      : [];
    const pipeline = pipelines.find((p) => {
      if (!p || typeof p !== "object") return false;
      const name = (p as Record<string, unknown>)["name"];
      return typeof name === "string" && name === PIPELINE_NAME;
    }) as Record<string, unknown> | undefined;

    if (!pipeline || typeof pipeline["id"] !== "string") {
      missing.push(`pipeline:${PIPELINE_NAME}`);
    }

    const stages: Partial<Record<LifecycleStage, string>> = {};
    const stageRows = Array.isArray(pipeline?.["stages"])
      ? pipeline["stages"]
      : [];
    for (const stage of STAGES) {
      const id = namedId(stageRows, stage);
      if (!id) missing.push(`stage:${stage}`);
      else stages[stage] = id;
    }

    const tagRows = Array.isArray(tagsBody["tags"]) ? tagsBody["tags"] : [];
    const tags: Record<string, string> = {};
    for (const tag of REQUIRED_TAGS) {
      const id = namedId(tagRows, tag);
      if (!id) missing.push(`tag:${tag}`);
      else tags[tag] = id;
    }

    const fieldRows = Array.isArray(fieldsBody["customFields"])
      ? fieldsBody["customFields"]
      : Array.isArray(fieldsBody["fields"])
        ? fieldsBody["fields"]
        : [];
    const fields: Record<string, string> = {};
    for (const fieldName of REQUIRED_FIELDS) {
      const id = namedId(fieldRows, fieldName);
      if (!id) missing.push(`field:${fieldName}`);
      else fields[fieldName] = id;
    }

    if (missing.length > 0 || !pipeline || typeof pipeline["id"] !== "string") {
      return { ok: false, error: "ghl_catalog_incomplete", missing };
    }

    const catalog: GhlCatalog = {
      pipelineId: pipeline["id"],
      stages: stages as Record<LifecycleStage, string>,
      tags,
      fields,
    };
    cached = { key: cacheKey, catalog };
    return { ok: true, catalog };
  } catch (err) {
    const message = err instanceof Error ? err.message : "ghl_catalog_failed";
    return { ok: false, error: message, missing };
  }
}

export function fieldId(catalog: GhlCatalog, name: keyof typeof FIELD_NAMES): string {
  return catalog.fields[FIELD_NAMES[name]]!;
}
