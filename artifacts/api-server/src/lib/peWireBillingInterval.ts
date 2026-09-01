/**
 * ONE TRANSLATION, AT THE WIRE BOUNDARY — and in its own module so it is
 * testable without a database.
 *
 * The column and the Stripe-derived mapper speak Stripe's vocabulary,
 * "month" | "year", because that is what the price ids and the webhook carry
 * and what the DDL CHECK enforces. The PRODUCT surface speaks
 * "monthly" | "annual" — the language of the pricing ladder, the rail's annual
 * rung, and the client's parse.
 *
 * Those two vocabularies met on the wire and nobody translated. The client
 * resolves ONLY the literal "monthly"/"annual" and returns null otherwise, so a
 * raw "month" would have read as UNKNOWN, the annual_upgrade rung would never
 * have fired, and it would have looked shipped while being permanently
 * starved. The client's own unrecognised-is-null safety is exactly what would
 * have made that silent rather than loud.
 *
 * The translation is TOTAL: an unrecognised value yields null rather than being
 * passed through, because a value this function does not understand is not a
 * fact about anyone's billing.
 *
 * This file imports the interval type ONLY as a type, so it pulls in no
 * database module and its tests run without DATABASE_URL. Same reason
 * peAiConnectionsClassify was split out of peAiConnections.
 */
import type { PeBillingInterval } from "@workspace/db/schema";

export type PeWireBillingInterval = "monthly" | "annual";

export function peWireBillingInterval(
  v: PeBillingInterval | null | undefined,
): PeWireBillingInterval | null {
  if (v === "month") return "monthly";
  if (v === "year") return "annual";
  return null;
}
