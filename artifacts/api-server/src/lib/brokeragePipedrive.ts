/**
 * Pipedrive CRM sync — operator GTM funnel only (sovereignty boundary).
 *
 * Expected Secret Manager name: PIPEDRIVE_API_TOKEN
 * Base URL: https://empressasolutionsllc.pipedrive.com/api/v1
 *
 * NEVER sync tenant-private research, buy-box, or adjudications.
 */

import { logger } from "./logger";

const PIPEDRIVE_BASE =
  process.env.PIPEDRIVE_API_BASE?.trim() ||
  "https://empressasolutionsllc.pipedrive.com/api/v1";

export function isPipedriveConfigured(): boolean {
  return Boolean(process.env.PIPEDRIVE_API_TOKEN?.trim());
}

export type PipedriveSyncResult =
  | { mode: "live"; objectType: string; id: number }
  | { mode: "simulated"; objectType: string; payload: Record<string, unknown> };

function apiToken(): string | null {
  return process.env.PIPEDRIVE_API_TOKEN?.trim() || null;
}

async function pipedrivePost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ id: number }> {
  const token = apiToken();
  if (!token) throw new Error("pipedrive_not_configured");

  const url = new URL(`${PIPEDRIVE_BASE}${path}`);
  url.searchParams.set("api_token", token);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    success?: boolean;
    data?: { id?: number };
    error?: string;
  };
  if (!res.ok || !json.success || !json.data?.id) {
    throw new Error(json.error ?? `Pipedrive POST ${path} failed (${res.status})`);
  }
  return { id: json.data.id };
}

/** Person on sign-up — identity + install id + acquisition source only. */
export async function syncPipedrivePerson(input: {
  email: string;
  installId: string;
  acquisitionSource?: string | null;
}): Promise<PipedriveSyncResult> {
  const payload = {
    name: input.email.split("@")[0] || "Hauska user",
    email: [{ value: input.email, primary: true, label: "work" }],
    "a8f3f9b2e1d04c6a9b0e2f1a3c4d5e6f": input.installId,
    visible_to: "3",
    label: input.acquisitionSource ?? "hauska_extension",
  };

  if (!isPipedriveConfigured()) {
    logger.info(
      { installId: input.installId.slice(0, 8) },
      "pipedrive: simulated person sync (no PIPEDRIVE_API_TOKEN)",
    );
    return { mode: "simulated", objectType: "person", payload };
  }

  const created = await pipedrivePost("/persons", payload);
  return { mode: "live", objectType: "person", id: created.id };
}

/** Deal when a free user hits Pro gate or starts upgrade. */
export async function syncPipedriveDeal(input: {
  installId: string;
  title: string;
  stage?: string;
  personId?: number | null;
}): Promise<PipedriveSyncResult> {
  const payload: Record<string, unknown> = {
    title: input.title,
    "a8f3f9b2e1d04c6a9b0e2f1a3c4d5e6f": input.installId,
    visible_to: "3",
  };
  if (input.personId) payload.person_id = input.personId;
  if (input.stage) payload.stage_id = input.stage;

  if (!isPipedriveConfigured()) {
    logger.info(
      { installId: input.installId.slice(0, 8), title: input.title },
      "pipedrive: simulated deal sync",
    );
    return { mode: "simulated", objectType: "deal", payload };
  }

  const created = await pipedrivePost("/deals", payload);
  return { mode: "live", objectType: "deal", id: created.id };
}

/** Lead for qualified prospect from GTM triage (signal only). */
export async function syncPipedriveLead(input: {
  installId: string;
  title: string;
  sourceEventId?: string;
  intentScore?: number;
}): Promise<PipedriveSyncResult> {
  const payload: Record<string, unknown> = {
    title: input.title,
    "a8f3f9b2e1d04c6a9b0e2f1a3c4d5e6f": input.installId,
    visible_to: "3",
    note: `qualified_prospect intent=${input.intentScore ?? "n/a"} event=${input.sourceEventId ?? "n/a"}`,
  };

  if (!isPipedriveConfigured()) {
    logger.info(
      { installId: input.installId.slice(0, 8) },
      "pipedrive: simulated lead sync",
    );
    return { mode: "simulated", objectType: "lead", payload };
  }

  const created = await pipedrivePost("/leads", payload);
  return { mode: "live", objectType: "lead", id: created.id };
}
