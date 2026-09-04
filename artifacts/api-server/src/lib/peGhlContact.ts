/**
 * GoHighLevel contact creation on a brand-new Property Explorer signup.
 *
 * Decision `_decisions/2026-08-31_gohighlevel_supersedes_pipedrive.md`
 * (doc_repo), 2026-09-04 addendum — the narrow, deliberate reversal of the
 * "no CRM record" half of the original "no sales CRM" ruling. What did NOT
 * reverse: no pipeline, no automation, no call sequence, no human sales
 * stage of any kind is ever pointed at a Smart Site subscriber. This module
 * creates a contact record only — name + email + one acquisition-source
 * tag. Nothing here ever writes a `tier-*` tag (`_smartsite_gtm/04_gohighlevel_agent_runbook.md`
 * Task 4: those are written only by the Stripe webhook off a real payment —
 * a tier typed in by a signup hook is a false record) and nothing here
 * creates or touches a pipeline/opportunity/automation.
 *
 * Fail-open, matching `claimInstallHistoryForUser` in
 * `./brokerageInstallClaim.ts` (the existing best-effort, non-auth-
 * precondition pattern already used one call above this one in
 * `routes/peAuth.ts`): a GHL outage, a 4xx, or a missing/bad credential
 * must never fail, or indefinitely hang, the sign-up response. Every path
 * through `createGhlContactForNewSignup` resolves (never throws) a
 * discriminated result; the request handler awaits it but treats any
 * `ok: false` as a no-op. A bounded request timeout keeps a GHL outage from
 * adding more than a few seconds to sign-in, since "await, but every error
 * is swallowed" — not true fire-and-forget — is the pattern already
 * established for this exact best-effort role in this same handler.
 */

import { logger } from "./logger";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

/** Bounded so a GHL outage cannot hang the sign-up response indefinitely. */
const GHL_REQUEST_TIMEOUT_MS = 4000;

/** The only acquisition-source tag this hook ever writes (R3 tag set, confirmed live via GET /locations/{id}/tags). */
const SIGNUP_SOURCE_TAG = "source-organic";

export type CreateGhlContactInput = {
  email: string;
  displayName: string;
};

export type CreateGhlContactResult =
  | { ok: true; contactId: string; isNewContact: boolean }
  | { ok: false; error: string };

function ghlConfig(): { apiKey: string; locationId: string } | null {
  const apiKey = process.env["GOHIGHLEVEL_API_KEY"]?.trim();
  const locationId = process.env["GOHIGHLEVEL_LOCATION_ID"]?.trim();
  if (!apiKey || !locationId) return null;
  return { apiKey, locationId };
}

/**
 * Upsert-by-email a GHL contact for a brand-new PE signup. Never throws —
 * every failure mode (unconfigured, no email, network error, non-2xx,
 * malformed response) returns `{ ok: false, error }` instead.
 */
export async function createGhlContactForNewSignup(
  input: CreateGhlContactInput,
): Promise<CreateGhlContactResult> {
  const config = ghlConfig();
  if (!config) {
    return { ok: false, error: "gohighlevel_not_configured" };
  }
  const email = input.email.trim();
  if (!email) {
    return { ok: false, error: "no_email" };
  }

  try {
    const res = await fetch(`${GHL_API_BASE}/contacts/upsert`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Version: GHL_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        locationId: config.locationId,
        email,
        name: input.displayName,
        // Contact creation only (name + email). No pipeline, no automation.
        // Never a tier-* tag from this hook — see file header.
        tags: [SIGNUP_SOURCE_TAG],
      }),
      signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
    });

    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    if (!res.ok) {
      const message =
        typeof body["message"] === "string"
          ? (body["message"] as string)
          : `GHL HTTP ${res.status}`;
      return { ok: false, error: message };
    }

    const contact = body["contact"] as Record<string, unknown> | undefined;
    const contactId =
      typeof contact?.["id"] === "string" ? (contact["id"] as string) : "";
    if (!contactId) {
      return { ok: false, error: "ghl_response_missing_contact_id" };
    }

    return { ok: true, contactId, isNewContact: body["new"] === true };
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

/**
 * Called from `POST /auth/session-exchange` only when `isNewUser` is true
 * (WDLL/decision-doc signal for a real signup, not a returning sign-in).
 * Best-effort: logs and swallows any non-`ok` result rather than letting it
 * reach the caller. The session-exchange response is never shaped by this
 * function's outcome.
 */
export async function notifyGhlOfNewPeSignup(
  input: CreateGhlContactInput,
): Promise<void> {
  const result = await createGhlContactForNewSignup(input);
  if (!result.ok) {
    logger.info(
      { email: input.email, error: result.error },
      "pe session-exchange: GHL contact creation did not complete (fail-open, sign-up unaffected)",
    );
    return;
  }
  logger.info(
    {
      email: input.email,
      contactId: result.contactId,
      isNewContact: result.isNewContact,
    },
    "pe session-exchange: GHL contact upserted for new signup",
  );
}
