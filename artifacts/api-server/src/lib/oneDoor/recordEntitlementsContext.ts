/**
 * The END USER's entitlement list for the duration of one request's parcel
 * reads, so the LEGACY `/record` client (`parcelRecordReaderClient.ts`,
 * reached through the SQL-shaped `ParcelRecordQueryable` seam by every
 * `*FromParcelRecord` / `*ServeCutover` reader) sends the same
 * `X-Hauska-Entitlements` header the one-door client sends, in EVERY mode.
 *
 * Why (hauska-engine #525, commit cf782c8): the reader now withholds the
 * gated rails (owner, exemptionCodes, the four CAD dollar rails, valueHistory,
 * salesHistory) on the legacy `rails` wire too -- `serve: "refused"`,
 * `refusal.code: "plan-gated"`, cell and companions empty -- unless the header
 * grants them. Without it, Studio users would lose their dollar values on the
 * old path the moment #525 deploys.
 *
 * Threading a parameter through the SQL-shaped seam would touch every rail
 * adapter; a request-scoped AsyncLocalStorage is set once per route instead.
 * Outside any scope the list is empty: default deny, exactly what the reader
 * assumes for a request with no header.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<readonly string[]>();

/** Run `fn` with `entitlements` as the current request's record entitlements. */
export function withRecordEntitlements<T>(
  entitlements: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run([...entitlements], fn);
}

/**
 * Set the record entitlements for the REST of the current async context (one
 * route handler serving one parcel). Use `withRecordEntitlements` instead
 * wherever several parcels are served concurrently from one context.
 */
export function enterRecordEntitlements(entitlements: readonly string[]): void {
  storage.enterWith([...entitlements]);
}

/** The current request's record entitlements; `[]` outside any scope. */
export function currentRecordEntitlements(): readonly string[] {
  return storage.getStore() ?? [];
}
