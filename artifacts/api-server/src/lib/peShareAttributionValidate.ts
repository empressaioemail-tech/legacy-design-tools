/**
 * P-100 item 3 — the share-attribution VALIDATOR.
 *
 * Pure. Imports no database, so every refusal below is testable without
 * Postgres. Mirrors the peActivationEventsValidate split: the logic lives
 * here, the query lives in `peShareAttribution.ts`.
 *
 * ATTRIBUTION IS NEVER WRITTEN BY THE CLIENT, AND "NEVER" HAS TWO HALVES.
 *
 * The first half is what the caller MAY send: a grant id, and nothing else
 * that identifies a person. The recipient's browser holds the grant id
 * because that id is in the URL it was handed; it is a capability it already
 * has, not a claim about anybody. Everything else — who shared, who is
 * signing up — is resolved server side, the sharer from the
 * `pe_share_grants` row and the recipient from the session the BFF verified.
 *
 * The second half is that a body naming a sharer is REFUSED, not ignored.
 * Stripping an unexpected field and carrying on leaves the caller believing
 * it set one, and leaves the next reader of the wire format believing the
 * field means something. A 400 that names the offending key is the only
 * response that cannot be misread. The refused key list is deliberately
 * broader than what any client sends today (`sharerUserId`, `referredBy`,
 * `attributedTo`, `referrerUserId` were the four the P-100 card grepped for,
 * and `grantorUserId` is the name this codebase actually uses) because the
 * cost of refusing a key nobody sends is zero and the cost of admitting one
 * is a fabricated attribution nothing can distinguish afterwards.
 */

/** Keys that assert an identity. Any of them present is a refusal. */
export const CLIENT_ASSERTED_IDENTITY_KEYS = [
  "grantorUserId",
  "grantor_user_id",
  "sharerUserId",
  "sharer_user_id",
  "referredBy",
  "referred_by",
  "attributedTo",
  "attributed_to",
  "referrerUserId",
  "referrer_user_id",
  "recipientUserId",
  "recipient_user_id",
] as const;

/** UUID, any RFC-4122 version. Mirrors `ShareGrantIdSchema` on the grant route. */
export const SHARE_GRANT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShareAttributionInput = {
  grantId: string;
  /** `null` = the caller sent no surface. NEVER a default. */
  surface: string | null;
};

export type ShareAttributionRefusal =
  | { error: "client_asserted_identity"; key: string }
  | { error: "invalid_grant_id" }
  | { error: "invalid_surface" };

export type ShareAttributionParse =
  | { ok: true; value: ShareAttributionInput }
  | { ok: false; refusal: ShareAttributionRefusal };

/**
 * Parse the request body a BFF forwards. The recipient's user id is NOT a
 * parameter here — it comes from the verified session on the route, and a
 * body that tries to supply it is refused by the identity-key list above.
 */
export function parseShareAttribution(body: unknown): ShareAttributionParse {
  const rec =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};

  for (const key of CLIENT_ASSERTED_IDENTITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rec, key)) {
      return { ok: false, refusal: { error: "client_asserted_identity", key } };
    }
  }

  const grantId = typeof rec.grantId === "string" ? rec.grantId.trim() : "";
  if (!SHARE_GRANT_ID_RE.test(grantId)) {
    return { ok: false, refusal: { error: "invalid_grant_id" } };
  }

  if (rec.surface !== undefined && rec.surface !== null) {
    if (typeof rec.surface !== "string" || rec.surface.trim() === "" || rec.surface.length > 32) {
      return { ok: false, refusal: { error: "invalid_surface" } };
    }
    return { ok: true, value: { grantId, surface: rec.surface.trim() } };
  }

  return { ok: true, value: { grantId, surface: null } };
}

// ---------------------------------------------------------------------------
// The write decision
// ---------------------------------------------------------------------------

/** What `pe_share_grants` holds for this id, or `null` when it holds nothing. */
export type ShareGrantSnapshot = { id: string; grantorUserId: string } | null;

export type ShareAttributionDecision =
  | { action: "attribute"; grantId: string; grantorUserId: string }
  | {
      action: "refuse";
      reason:
        | "grant_not_found"
        | "self_attribution"
        | "already_attributed";
    };

/**
 * Decide whether this recipient may be attributed to this grant.
 *
 * REVOKED AND EXPIRED GRANTS STILL ATTRIBUTE, and that is a decision rather
 * than an omission. Revocation and expiry govern ACCESS to the shared
 * property; they say nothing about the historical fact that this recipient
 * arrived through this sharer's link. A recipient who viewed a link on Monday
 * and signed up on Friday, after the sharer revoked it, still came from that
 * sharer. Refusing there would silently drop a real signup, which is the
 * failure this whole table exists to prevent. So this function is not given
 * the expiry or the revocation at all — passing them in would invite a future
 * reader to start branching on them.
 *
 * FIRST TOUCH WINS. `existingGrantId` is what the store already holds for
 * this recipient. When it is present the answer is `already_attributed` and
 * the caller reports the ORIGINAL grant, never the new one. The database
 * enforces the same thing independently (the recipient id is the primary
 * key), so this branch is the readable error rather than the control.
 */
export function decideShareAttribution(input: {
  grant: ShareGrantSnapshot;
  recipientUserId: string;
  existingGrantId: string | null;
}): ShareAttributionDecision {
  if (input.existingGrantId !== null) {
    return { action: "refuse", reason: "already_attributed" };
  }
  if (input.grant === null) {
    return { action: "refuse", reason: "grant_not_found" };
  }
  if (input.grant.grantorUserId === input.recipientUserId) {
    return { action: "refuse", reason: "self_attribution" };
  }
  return {
    action: "attribute",
    grantId: input.grant.id,
    grantorUserId: input.grant.grantorUserId,
  };
}
