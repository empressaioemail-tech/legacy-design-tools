/**
 * P-492 — prepare the operator's Resend account for the lifecycle outbox.
 * Run by the integration seat BEFORE the deploy that turns the leg on.
 *
 *   RESEND_API_KEY=... pnpm --filter @workspace/api-server exec tsx src/resendLifecycleSetupCli.ts          # dry run
 *   RESEND_API_KEY=... pnpm --filter @workspace/api-server exec tsx src/resendLifecycleSetupCli.ts --apply  # create
 *
 * Idempotent: lists what exists and creates only what is missing —
 *   - the 9 contract v2 Smart Site contact properties (first_name is built in);
 *   - the 12 contract v2 events (`ss.plan_started` / `ss.plan_cancelled`
 *     with the schema {previous_plan: string});
 *   - the two segments, "Smart Site" and "Smart Site Affiliates", whose ids
 *     it prints for RESEND_SS_SEGMENT_ID and RESEND_AFFILIATE_SEGMENT_ID.
 *
 * The names come from `lib/peLifecycleTypes.ts`, the one copy the outbox
 * sends, so the account and the code cannot drift apart by a typo.
 *
 * Request shapes: https://resend.com/docs/api-reference/contact-properties/
 * {list,create}-contact-property.md, events/{list,create}-event.md,
 * segments/{list,create}-segment.md (read 2026-10-03). A list that reports
 * `has_more: true` stops the run rather than creating duplicates from a
 * partial read.
 */

import {
  RESEND_EVENT_NAMES,
  SS_CONTACT_PROPERTY_TYPES,
} from "./lib/peLifecycleTypes";

const BASE = "https://api.resend.com";
const SEGMENTS = ["Smart Site", "Smart Site Affiliates"] as const;
const EVENT_SCHEMAS: Record<string, Record<string, string>> = {
  "ss.plan_started": { previous_plan: "string" },
  "ss.plan_cancelled": { previous_plan: "string" },
};

const apiKey = process.env["RESEND_API_KEY"]?.trim();
const apply = process.argv.includes("--apply");

async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  await new Promise((r) => setTimeout(r, 400));
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function list(path: string): Promise<Record<string, unknown>[]> {
  const body = await call("GET", path);
  if (body["has_more"] === true) {
    throw new Error(`${path} has more than one page; refusing to create from a partial list`);
  }
  return Array.isArray(body["data"]) ? (body["data"] as Record<string, unknown>[]) : [];
}

async function main(): Promise<void> {
  if (!apiKey) {
    console.error("RESEND_API_KEY unset; nothing done");
    process.exit(2);
  }
  console.log(apply ? "MODE: apply (creating what is missing)" : "MODE: dry run (pass --apply to create)");

  const props = await list("/contact-properties");
  const haveProps = new Map(props.map((p) => [String(p["key"]), String(p["type"])]));
  for (const [key, type] of Object.entries(SS_CONTACT_PROPERTY_TYPES)) {
    const have = haveProps.get(key);
    if (have === type) {
      console.log(`property ${key}: present (${type})`);
    } else if (have) {
      console.log(`property ${key}: PRESENT WITH WRONG TYPE ${have} (want ${type}); fix by hand, not changed`);
    } else if (apply) {
      await call("POST", "/contact-properties", { key, type });
      console.log(`property ${key}: created (${type})`);
    } else {
      console.log(`property ${key}: MISSING (${type})`);
    }
  }

  const events = await list("/events");
  const haveEvents = new Set(events.map((e) => String(e["name"])));
  for (const name of Object.values(RESEND_EVENT_NAMES)) {
    if (!name) continue;
    if (haveEvents.has(name)) {
      console.log(`event ${name}: present`);
    } else if (apply) {
      await call("POST", "/events", {
        name,
        ...(EVENT_SCHEMAS[name] ? { schema: EVENT_SCHEMAS[name] } : {}),
      });
      console.log(`event ${name}: created`);
    } else {
      console.log(`event ${name}: MISSING`);
    }
  }

  const segments = await list("/segments");
  for (const name of SEGMENTS) {
    const found = segments.find((s) => s["name"] === name);
    if (found) {
      console.log(`segment "${name}": present id=${String(found["id"])}`);
    } else if (apply) {
      const created = await call("POST", "/segments", { name });
      console.log(`segment "${name}": created id=${String(created["id"])}`);
    } else {
      console.log(`segment "${name}": MISSING`);
    }
  }
  console.log(
    "Set RESEND_SS_SEGMENT_ID to the \"Smart Site\" id and RESEND_AFFILIATE_SEGMENT_ID to the \"Smart Site Affiliates\" id on cortex-api.",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
