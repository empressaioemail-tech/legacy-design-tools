/**
 * One wording for "your plan does not include this".
 *
 * The same upgrade_required refusal used to read three ways: get_smart_site
 * sent only the parcel id, create_screen sent the screens gate's own message,
 * and find_parcel's map panel sent a third sentence. Every one now carries
 * the same `reasonDisplayText` and the same `plansUrl`; the gate's own
 * `message` stays beside it as the detail of what was refused.
 */

import { SMARTSITE_PLANS_URL } from "./entitlement.js";
import type { ToolResult } from "./tools-types.js";

export const PLAN_REFUSAL_SENTENCE =
  "Your current Smart Site plan does not include this.";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Rewrites one parsed tool body in place of its refusal wording; returns null when it is not a plan refusal. */
export function withPlanRefusalWording(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const refused = Array.isArray(body.refused) ? body.refused : null;
  const isParcelRefusal =
    refused !== null &&
    refused.length > 0 &&
    refused.every((r) => asRecord(r)?.reason === "upgrade_required");
  const isGateRefusal = body.status === "upgrade_required";
  const isMapRefusal = body.mapPanelReason === "map_upgrade_required";
  if (!isParcelRefusal && !isGateRefusal && !isMapRefusal) return null;

  const out: Record<string, unknown> = {
    ...body,
    reasonDisplayText: PLAN_REFUSAL_SENTENCE,
    plansUrl: SMARTSITE_PLANS_URL,
  };
  if (isParcelRefusal) {
    out.refused = refused.map((r) => ({
      ...(asRecord(r) as Record<string, unknown>),
      reasonDisplayText: PLAN_REFUSAL_SENTENCE,
      plansUrl: SMARTSITE_PLANS_URL,
    }));
  }
  if (isMapRefusal) out.mapPanelNote = PLAN_REFUSAL_SENTENCE;
  return out;
}

/** Applies {@link withPlanRefusalWording} to every JSON text part of a result. */
export function applyPlanRefusalWording<T extends ToolResult>(result: T): T {
  let changed = false;
  const content = result.content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    let parsed: unknown;
    try {
      parsed = JSON.parse(part.text);
    } catch {
      return part;
    }
    const body = asRecord(parsed);
    const next = body ? withPlanRefusalWording(body) : null;
    if (!next) return part;
    changed = true;
    return { ...part, text: JSON.stringify(next) };
  });
  const structured = asRecord(result.structuredContent);
  const structuredNext = structured ? withPlanRefusalWording(structured) : null;
  if (structuredNext) changed = true;
  if (!changed) return result;
  return {
    ...result,
    content,
    ...(structuredNext ? { structuredContent: structuredNext } : {}),
  };
}
