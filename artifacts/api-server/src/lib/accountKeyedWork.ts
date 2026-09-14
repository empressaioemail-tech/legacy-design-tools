/**
 * P-180 (2026-09-13). DURABLE RETIREMENT OF THE HOLLOW ACCOUNT-KEYED NODES.
 *
 * For a gate-blocked county the `atoms` table carries BOTH the canonical
 * TxGIO-keyed node (the parcel with geometry and cells, e.g. 48209:97658) AND
 * account-keyed atoms minted from the CAD roll's own `PropertyID` (e.g.
 * 48209:84639, 84632-84638). The latter are HOLLOW: no `txgio_parcel` row
 * publishes that prop_id, so the node has no geometry and serves a card that
 * describes an ACCOUNT, not the parcel. P-177 retired five of them with a
 * snapshot marker, but that marker is not durable -- the tier-1 bake re-mints
 * one work item per CAD atom on every republish, overwriting it.
 *
 * The durable half is to DROP them before any prepass or write: for a
 * gate-blocked county a work item whose prop_id is not a TxGIO node id is
 * account-keyed. Measured live (2026-09-14, production, read-only):
 * 84639/84632/84633/84634/84638 have zero `txgio_parcel` rows for 48209 while
 * 97658 has one, so the rule excludes exactly the hollow set and keeps every
 * real node.
 *
 * A non-blocked county never calls this: there the bare prop_id IS the CAD
 * account id and every atom key is a real node key.
 */
export function isAccountKeyedNodeId(
  propId: string,
  txgioPropIds: ReadonlySet<string>,
): boolean {
  const id = propId.trim();
  if (id === "") return false;
  return !txgioPropIds.has(id);
}
