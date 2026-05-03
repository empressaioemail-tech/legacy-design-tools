/**
 * Task #482 — QA Dashboard runtime settings (autopilot toggle).
 * Task #484 — Adds optional webhook notification settings so red
 * sweeps can be surfaced to a Slack/Teams/etc. inbox without anyone
 * needing the dashboard open.
 *
 * Backed by the tiny `qa_settings` kv table. Keys in use today:
 *   - `autopilot.enabled`            : "true" | "false"
 *   - `autopilot.notify.webhook`     : URL string (empty disables)
 *   - `autopilot.notify.minSeverity` : "warning" | "error"
 *
 * The kv shape is intentionally generic so subsequent dashboard
 * toggles can land without a schema migration.
 */

import { db, qaSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import { promises as dns } from "node:dns";
import net from "node:net";

export type QaSettingKey =
  | "autopilot.enabled"
  | "autopilot.notify.webhook"
  | "autopilot.notify.minSeverity";

export type AutopilotNotifyMinSeverity = "warning" | "error";

const DEFAULTS: Record<QaSettingKey, string> = {
  "autopilot.enabled": "true",
  "autopilot.notify.webhook": "",
  "autopilot.notify.minSeverity": "error",
};

export async function getSetting(key: QaSettingKey): Promise<string> {
  const [row] = await db
    .select()
    .from(qaSettings)
    .where(eq(qaSettings.key, key))
    .limit(1);
  return row?.value ?? DEFAULTS[key];
}

export async function setSetting(
  key: QaSettingKey,
  value: string,
): Promise<void> {
  await db
    .insert(qaSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: qaSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function isAutopilotEnabled(): Promise<boolean> {
  return (await getSetting("autopilot.enabled")) === "true";
}

export interface AutopilotNotifySettings {
  webhook: string;
  minSeverity: AutopilotNotifyMinSeverity;
}

/**
 * Public, safe-to-return view of the notify settings. The full
 * webhook URL is treated as a bearer secret (Slack/Teams-style
 * incoming webhooks embed the secret in the path), so we never echo
 * it back to API callers — only an `enabled` flag and a `hint`
 * showing the host so admins can recognize what's configured.
 */
export interface AutopilotNotifyPublic {
  enabled: boolean;
  hint: string | null;
  minSeverity: AutopilotNotifyMinSeverity;
}

function normalizeMinSeverity(raw: string): AutopilotNotifyMinSeverity {
  return raw === "warning" ? "warning" : "error";
}

export async function getAutopilotNotifySettings(): Promise<AutopilotNotifySettings> {
  const [webhook, minSeverity] = await Promise.all([
    getSetting("autopilot.notify.webhook"),
    getSetting("autopilot.notify.minSeverity"),
  ]);
  return {
    webhook: webhook.trim(),
    minSeverity: normalizeMinSeverity(minSeverity),
  };
}

export function maskWebhookUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.hostname}/…`;
  } catch {
    return "(invalid)";
  }
}

export async function getAutopilotNotifyPublic(): Promise<AutopilotNotifyPublic> {
  const s = await getAutopilotNotifySettings();
  return {
    enabled: s.webhook.length > 0,
    hint: maskWebhookUrl(s.webhook),
    minSeverity: s.minSeverity,
  };
}

// ---------------------------------------------------------------------------
// SSRF guard for the autopilot notification webhook.
//
// Webhooks are user-controllable URLs the server fetches on its own,
// which is a textbook SSRF sink. We require https, reject hosts whose
// resolved addresses live in loopback / private / link-local /
// reserved ranges, and forbid embedded credentials. Operators can opt
// in to additional behavior (e.g. plaintext for testing) by setting
// QA_AUTOPILOT_ALLOW_INSECURE_WEBHOOKS=1, but the default posture is
// locked-down.
// ---------------------------------------------------------------------------

export class WebhookValidationError extends Error {
  constructor(
    public readonly code:
      | "invalid_url"
      | "scheme_not_allowed"
      | "credentials_not_allowed"
      | "private_address_not_allowed"
      | "lookup_failed",
    message: string,
  ) {
    super(message);
    this.name = "WebhookValidationError";
  }
}

function isPrivateOrReservedIp(addr: string): boolean {
  // Canonicalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1).
  const bare = addr.replace(/^::ffff:/i, "");
  const family = net.isIP(bare);
  if (family === 4) return isPrivateIpv4(bare);
  if (family === 6) return isPrivateIpv6(bare);
  // Anything that doesn't parse as an IP at this point is treated as
  // unsafe — the caller resolved DNS so every value passed in here
  // should be a literal address.
  return true;
}

function isPrivateIpv4(addr: string): boolean {
  const parts = addr.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA fc00::/7
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

function isInsecureAllowed(): boolean {
  return process.env["QA_AUTOPILOT_ALLOW_INSECURE_WEBHOOKS"] === "1";
}

/**
 * Validate that `raw` is a webhook URL we are willing to POST to.
 * Throws WebhookValidationError on rejection. Performs DNS resolution
 * and rejects if any resolved address is private/loopback/reserved.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookValidationError("invalid_url", "Webhook URL is not parseable");
  }
  const allowInsecure = isInsecureAllowed();
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new WebhookValidationError(
      "scheme_not_allowed",
      "Webhook URL must use https://",
    );
  }
  if (url.username || url.password) {
    throw new WebhookValidationError(
      "credentials_not_allowed",
      "Webhook URL must not embed userinfo",
    );
  }
  // Quick literal-IP rejection before even hitting DNS.
  if (net.isIP(url.hostname) && isPrivateOrReservedIp(url.hostname) && !allowInsecure) {
    throw new WebhookValidationError(
      "private_address_not_allowed",
      "Webhook URL resolves to a private or reserved address",
    );
  }
  if (
    !allowInsecure &&
    (url.hostname === "localhost" || url.hostname.endsWith(".localhost"))
  ) {
    throw new WebhookValidationError(
      "private_address_not_allowed",
      "Webhook URL resolves to a private or reserved address",
    );
  }
  let resolved: { address: string; family: number }[];
  try {
    resolved = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new WebhookValidationError(
      "lookup_failed",
      "Webhook hostname could not be resolved",
    );
  }
  if (!allowInsecure) {
    for (const r of resolved) {
      if (isPrivateOrReservedIp(r.address)) {
        throw new WebhookValidationError(
          "private_address_not_allowed",
          "Webhook URL resolves to a private or reserved address",
        );
      }
    }
  }
  return url;
}
