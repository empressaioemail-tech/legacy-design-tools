/**
 * Test fixture — a representative `JurisdictionSummary` wire object
 * (the `GET /api/codes/jurisdictions` L-route shape). Shared by the
 * jurisdiction-helper and JurisdictionBar suites.
 */
import type { JurisdictionSummary } from "@workspace/api-client-react";

export function makeJurisdiction(
  overrides: Partial<JurisdictionSummary> = {},
): JurisdictionSummary {
  return {
    key: "grand-county",
    displayName: "Grand County",
    atomCount: 1240,
    embeddedCount: 1240,
    lastFetchedAt: "2026-05-10T00:00:00.000Z",
    books: [],
    ...overrides,
  };
}
