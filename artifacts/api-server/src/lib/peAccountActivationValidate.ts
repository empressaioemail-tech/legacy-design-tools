/**
 * P-100 item 4 — the account-activation VALIDATOR.
 *
 * Pure. Imports no database, so every refusal below is testable without
 * Postgres.
 *
 * WHY THE MILESTONE SET REFUSES RATHER THAN DEFAULTS. A defaulted milestone
 * attributes an activation to a moment that did not happen, and the row is
 * afterwards indistinguishable from a real one — it enters the activation
 * rate, the affiliate audience comparison, and every ratio built on them,
 * with nothing to subtract it by. The three values are the ones P-100 item 4
 * names and they are frozen in DDL as well, so a raw connection cannot get
 * past this either.
 *
 * THE 400 BODY NAMES THE ALLOWED SET. This route is best-effort telemetry
 * from a client that drops failures on purpose, so a silent refusal would be
 * undiagnosable from outside. Naming the vocabulary makes a client/server
 * drift self-explaining the first time somebody reads a response.
 *
 * `surface` MAY BE ABSENT AND MAY NOT BE BLANK. Absent means unmeasured;
 * blank would be a sentinel that passes a not-null test while meaning
 * nothing, so it is refused.
 */

/** The milestone grammar. Closed at three; mirrored by the DDL check. */
export const PE_ACCOUNT_ACTIVATION_MILESTONES = [
  "first_parcel_inspected",
  "first_property_saved",
  "first_report_opened",
] as const;

export type PeAccountActivationMilestoneValue =
  (typeof PE_ACCOUNT_ACTIVATION_MILESTONES)[number];

export type AccountActivationInput = {
  milestone: PeAccountActivationMilestoneValue;
  /** `null` = the caller sent no surface. NEVER a default. */
  surface: string | null;
};

export type AccountActivationRefusal = {
  error: "invalid_milestone" | "invalid_surface";
  allowed?: readonly string[];
};

export type AccountActivationParse =
  | { ok: true; value: AccountActivationInput }
  | { ok: false; refusal: AccountActivationRefusal };

function isMilestone(v: unknown): v is PeAccountActivationMilestoneValue {
  return (
    typeof v === "string" &&
    (PE_ACCOUNT_ACTIVATION_MILESTONES as readonly string[]).includes(v)
  );
}

export function parseAccountActivation(body: unknown): AccountActivationParse {
  const rec =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};

  if (!isMilestone(rec.milestone)) {
    return {
      ok: false,
      refusal: {
        error: "invalid_milestone",
        allowed: PE_ACCOUNT_ACTIVATION_MILESTONES,
      },
    };
  }

  if (rec.surface === undefined || rec.surface === null) {
    return { ok: true, value: { milestone: rec.milestone, surface: null } };
  }
  if (
    typeof rec.surface !== "string" ||
    rec.surface.trim() === "" ||
    rec.surface.length > 32
  ) {
    return { ok: false, refusal: { error: "invalid_surface" } };
  }
  return {
    ok: true,
    value: { milestone: rec.milestone, surface: rec.surface.trim() },
  };
}
