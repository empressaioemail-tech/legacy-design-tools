/**
 * P-112 email leg — magic-link email delivery via Resend.
 *
 * Deliberately a SEPARATE Resend caller from
 * `recordsRequestCompletionEmail.ts` (courthouse-records completion
 * notices) — same provider, same `POST https://api.resend.com/emails`
 * bearer-auth shape (copied from that file, which is the one existing
 * caller of `RESEND_API_KEY`), but a different purpose. The two are not
 * coupled: this module has its own `from` address env var and its own
 * content, and neither imports the other.
 *
 * Fail-open in IMPLEMENTATION SHAPE only, matching this codebase's
 * established non-throwing-result pattern (`claimInstallHistoryForUser` in
 * `brokerageInstallClaim.ts` — confirmed as the pattern actually wired into
 * `peAuth.ts`'s session-exchange today, not `claimClient.ts`'s
 * `claimAnonymousStateOnSignIn`, which a prior session found was not the
 * live path). `sendMagicLinkEmail` never throws; every failure mode
 * resolves to a discriminated `{ ok: false, error }` result instead.
 *
 * But UNLIKE the GHL signup hook (which is fail-open in OUTCOME too — a
 * failure there is a silent best-effort no-op because it is a side effect
 * of a signup that already succeeded some other way), a magic-link SEND
 * failure is the primary thing this endpoint exists to do. The route
 * calling `sendMagicLinkEmail` must surface a real, honest error to the
 * caller when it fails — "couldn't send, try again" — never a fake
 * "check your email" success. See `routes/peMagicLink.ts`.
 */

import { parseCampaignWire, serializeCampaign } from "./peCampaignSource";
const RESEND_API_URL = "https://api.resend.com/emails";

export function magicLinkEmailFrom(): string {
  return (
    process.env.PE_MAGIC_LINK_EMAIL_FROM?.trim() ||
    "Smart Site <sign-in@smartsite.cloud>"
  );
}

export function magicLinkLoginBaseUrl(): string {
  return (
    process.env.PE_MAGIC_LINK_BASE_URL?.trim()?.replace(/\/$/, "") ||
    "https://smartsite.cloud"
  );
}

/**
 * The verify link. A first-touch campaign set, when the visitor arrived with
 * one, rides on the link as the same utm_* parameters the OAuth start URL
 * carries, so the attribution survives a phone opening the link in a different
 * browser from the one that landed on the ad. Re-sanitized here: only the
 * known keys and values that pass `parseCampaignWire` are written.
 */
export function buildMagicLinkUrl(rawToken: string, campaign?: string): string {
  const base = `${magicLinkLoginBaseUrl()}/api/auth/email/verify?token=${encodeURIComponent(rawToken)}`;
  if (!campaign) return base;
  // Same character rule the BFF applies (hauska-map api/_lib/campaign.ts
  // ALLOWED_VALUE): a value outside it is dropped whole, not escaped.
  const safe = Object.fromEntries(
    Object.entries(parseCampaignWire(campaign)).filter(([, v]) => /^[A-Za-z0-9 ._~:+-]+$/.test(v)),
  );
  const utms = serializeCampaign(safe);
  return utms ? `${base}&${utms}` : base;
}

export function buildMagicLinkEmail(args: {
  rawToken: string;
  expiresAt: Date;
  campaign?: string;
}): { subject: string; html: string; text: string } {
  const link = buildMagicLinkUrl(args.rawToken, args.campaign);
  const minutes = Math.round(
    (args.expiresAt.getTime() - Date.now()) / (60 * 1000),
  );
  const subject = "Your Smart Site sign-in link";
  const text = `Click to sign in to Smart Site:\n\n${link}\n\nThis link expires in about ${minutes} minutes and can only be used once. If you didn't request this, you can ignore this email.`;
  const html = `<p>Click below to sign in to Smart Site.</p><p><a href="${link}">Sign in to Smart Site</a></p><p style="color:#64748b;font-size:12px;">This link expires in about ${minutes} minutes and can only be used once. If you didn't request this, you can ignore this email.</p>`;
  return { subject, html, text };
}

export type SendMagicLinkEmailResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * POST the magic-link email via Resend. Copies
 * `recordsRequestCompletionEmail.ts`'s `sendViaResend` request shape
 * exactly (bearer auth, JSON body, `from`/`to`/`subject`/`html`/`text`) —
 * intentionally not imported from there, per the file header above.
 *
 * Never throws. Never logs or returns the raw token — the token only ever
 * appears inside the `link` embedded in the email body sent to Resend.
 */
export async function sendMagicLinkEmail(args: {
  to: string;
  rawToken: string;
  expiresAt: Date;
  campaign?: string;
}): Promise<SendMagicLinkEmailResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "RESEND_API_KEY unset" };
  }
  const mail = buildMagicLinkEmail({
    rawToken: args.rawToken,
    expiresAt: args.expiresAt,
    ...(args.campaign ? { campaign: args.campaign } : {}),
  });
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: magicLinkEmailFrom(),
        to: [args.to],
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      const message =
        typeof body.message === "string"
          ? body.message
          : `Resend HTTP ${res.status}`;
      return { ok: false, error: message };
    }
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) {
      return { ok: false, error: "Resend response missing id" };
    }
    return { ok: true, id };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? "resend_request_timeout"
          : err.message
        : "unknown_error";
    return { ok: false, error: message };
  }
}
