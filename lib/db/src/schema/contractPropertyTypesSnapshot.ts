/**
 * Atom types published on `@empressaio/atom-contract` `./property` that may
 * exist before hauska-engine registers them in `PROPERTY_ENTITY_TYPES`.
 * Used fail-closed for rails like `roads` (`road-node`): present in contract,
 * not yet in the engine registration list.
 */
export const CONTRACT_PROPERTY_TYPES_SNAPSHOT = {
  contractVersion: "1.19.0",
  sourcePath: "@empressaio/atom-contract/property exports",
  types: [
    "parcel-node",
    "zoning-fact",
    "setback-rule",
    "buildable-envelope",
    "parcel-terrain-model",
    "road-node",
    "building-footprint",
    "utility-easement",
    "flood-hazard-fact",
    "cad-parcel-roll",
    "land-use-fact",
    "owner-fact",
    "rail-corridor-fact",
    "well-fact",
    "special-district-fact",
  ],
} as const;

export type ContractPropertyTypesSnapshot = typeof CONTRACT_PROPERTY_TYPES_SNAPSHOT;

export function contractTypeSet(
  snapshot: ContractPropertyTypesSnapshot = CONTRACT_PROPERTY_TYPES_SNAPSHOT,
): ReadonlySet<string> {
  return new Set(snapshot.types);
}
