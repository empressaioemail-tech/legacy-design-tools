/**
 * Must match hauska-factory src/lib/conformant-store-predicate.mjs (V11 grader).
 */
export const CONFORMANT_SHAPE = "conformant-v1";

export function conformantCadCountyWhere(paramIndex = 1) {
  return `entity_type = 'cad-parcel-roll'
    AND jurisdiction_tenant = $${paramIndex}
    AND coalesce(body->>'shape', '') = '${CONFORMANT_SHAPE}'`;
}
