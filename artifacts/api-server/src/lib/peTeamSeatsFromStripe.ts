/**
 * Team seat count from billed Stripe items. The webhook grant reads this
 * and writes `pe_user_entitlements.seats_purchased`. Unknown stays null.
 * Never invent the included-10 from a Team tier flag alone.
 */

import type { PeSubscriptionTier } from "@workspace/db";

/** Seats included in the Team base price (LOCKED ladder: "$299/mo for up to 10 seats"). */
export const PE_TEAM_INCLUDED_SEATS = 10;

export type StripePriceItem = {
  priceId: string | null;
  quantity: number | null;
};

export function configuredTeamPriceIds(): string[] {
  return [
    process.env.STRIPE_TEAM_PRICE_ID?.trim(),
    process.env.STRIPE_TEAM_ANNUAL_PRICE_ID?.trim(),
  ].filter((id): id is string => Boolean(id));
}

export function configuredExtraSeatPriceId(): string | null {
  return process.env.STRIPE_TEAM_SEAT_PRICE_ID?.trim() || null;
}

export function parseMetadataSeats(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return null;
}

function priceIdFromItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const price = (item as { price?: unknown }).price;
  if (typeof price === "string" && price) return price;
  if (price && typeof price === "object") {
    const id = (price as { id?: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function quantityFromItem(item: unknown): number | null {
  if (!item || typeof item !== "object") return null;
  const q = (item as { quantity?: unknown }).quantity;
  if (typeof q === "number" && Number.isInteger(q) && q >= 0) return q;
  if (typeof q === "string" && /^\d+$/.test(q)) return Number(q);
  return null;
}

/**
 * Checkout sessions carry `line_items`; subscriptions carry `items`.
 * Either may be absent until expanded or fetched.
 */
export function extractStripePriceItems(
  obj: Record<string, unknown>,
): StripePriceItem[] {
  const lineItems = obj.line_items as { data?: unknown[] } | undefined;
  const subItems = obj.items as { data?: unknown[] } | undefined;
  const data = Array.isArray(lineItems?.data)
    ? lineItems.data
    : Array.isArray(subItems?.data)
      ? subItems.data
      : [];
  return data.map((item) => ({
    priceId: priceIdFromItem(item),
    quantity: quantityFromItem(item),
  }));
}

/**
 * Resolve the seat count to persist.
 *
 * Team + billed Team base price → 10 + extra-seat quantities.
 * No readable base item → null (do not invent 10).
 * Metadata present and different from billed → null.
 * Non-team grant → null.
 */
export function resolveTeamSeatsPurchased(input: {
  grantTier: PeSubscriptionTier | null;
  metadataSeats: number | null;
  items: StripePriceItem[];
  teamPriceIds: readonly string[];
  extraSeatPriceId: string | null;
}): number | null {
  if (input.grantTier !== "team") return null;
  if (input.teamPriceIds.length === 0) return null;

  const teamPrices = new Set(input.teamPriceIds);
  const extrasPrice = input.extraSeatPriceId;

  let baseFound = false;
  let extras = 0;
  for (const item of input.items) {
    if (item.priceId && teamPrices.has(item.priceId)) {
      if (item.quantity !== null && item.quantity !== 1) return null;
      baseFound = true;
      continue;
    }
    if (extrasPrice && item.priceId === extrasPrice) {
      if (item.quantity === null) return null;
      extras += item.quantity;
    }
  }
  if (!baseFound) return null;

  const computed = PE_TEAM_INCLUDED_SEATS + extras;
  if (input.metadataSeats !== null && input.metadataSeats !== computed) {
    return null;
  }
  return computed;
}
