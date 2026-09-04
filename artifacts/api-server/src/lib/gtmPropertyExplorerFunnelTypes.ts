/**
 * Property Explorer funnel VOCABULARY. Pure — imports no database.
 *
 * Split out of `gtmPropertyExplorerFunnel.ts` by P-100 so the allowlist and
 * its guard can be asserted without `DATABASE_URL`. The metrics half of that
 * file imports `@workspace/db`, which throws at module load when no database
 * is configured; a test of a string list should not need Postgres to run, and
 * a check that only runs where Postgres is reachable is a check that mostly
 * does not run.
 *
 * `gtmPropertyExplorerFunnel.ts` re-exports everything here, so no consumer
 * import changed.
 */

/**
 * P-100 item 2. `share_created` and `share_viewed` are in this list so the
 * Smart Site share plane can emit through the writer that already exists.
 *
 * THEY SHARE A TYPE NAME WITH THE BROKERAGE WORKSPACE AND THEY ARE A
 * DIFFERENT SUBJECT. `brokerageWorkspace.ts` emits the same two names for
 * workspace shares on `source_surface = 'api'`; these fire on
 * `source_surface = 'property-explorer'`. The readout reports the two
 * surfaces SPLIT and never sums them, because a workspace share and a Smart
 * Site parcel share are not the same event counted twice. No second insert
 * into `gtm_events` was added for them — they go through the one insert the
 * property-explorer events route already owns.
 */
/**
 * P-118. `pe_help_widget_opened` and `pe_help_widget_message_sent` are the
 * ungated Help widget's own usage, fed through this SAME writer per the
 * card's own instruction ("its own usage should feed the SAME funnel-event
 * instrumentation P-100 already built") — no second writer, no parallel
 * analytics mechanism. Fired client-side from HelpWidget.tsx via the
 * existing recordPeGtmEvent, exactly the pattern share_created/share_viewed
 * already established.
 */
export const PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES = [
  "pe_browse_started",
  "pe_cold_open_dismissed",
  "pe_signup_intent",
  "pe_save_property",
  "pe_research_clicked",
  "pe_paywall_hit",
  "pe_upgrade_started",
  "share_created",
  "share_viewed",
  "pe_help_widget_opened",
  "pe_help_widget_message_sent",
] as const;

export type PropertyExplorerFunnelEventType =
  (typeof PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES)[number];

export const PE_GTM_CONSENT_VERSION = "2026-07-21-property-explorer-v1";

export function isPropertyExplorerFunnelEventType(
  eventType: string,
): eventType is PropertyExplorerFunnelEventType {
  return (PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES as readonly string[]).includes(
    eventType,
  );
}

/** CRM-worthy intent on the consumer map surface. */
export function isPropertyExplorerCrmEvent(eventType: string): boolean {
  return (
    eventType === "pe_signup_intent" ||
    eventType === "pe_save_property" ||
    eventType === "pe_research_clicked" ||
    eventType === "pe_paywall_hit" ||
    eventType === "pe_upgrade_started"
  );
}

export function peSyntheticEmail(installId: string): string {
  const local = installId.slice(0, 24).replace(/[^a-zA-Z0-9]/g, "") || "visitor";
  return `${local}@pe.empressa.local`;
}
