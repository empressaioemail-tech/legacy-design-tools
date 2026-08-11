/**
 * Checked-in snapshot of hauska-engine `PROPERTY_ENTITY_TYPES`
 * (`packages/atoms/src/property-instances.ts`). Refreshed when engine
 * registration changes; pin `engineMainSha` to the commit verified.
 *
 * This repo has no live import edge to the engine constant — the snapshot
 * is the CI-fail-closed bridge for `deriveAtomFamilyState`.
 */
export const ENGINE_PROPERTY_TYPES_SNAPSHOT = {
  engineMainSha: "34c94ff",
  sourcePath: "packages/atoms/src/property-instances.ts",
  types: [
    "parcel-node",
    "zoning-fact",
    "setback-rule",
    "buildable-envelope",
    "parcel-terrain-model",
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

export type EnginePropertyTypesSnapshot = typeof ENGINE_PROPERTY_TYPES_SNAPSHOT;

export function snapshotTypeSet(
  snapshot: EnginePropertyTypesSnapshot = ENGINE_PROPERTY_TYPES_SNAPSHOT,
): ReadonlySet<string> {
  return new Set(snapshot.types);
}
