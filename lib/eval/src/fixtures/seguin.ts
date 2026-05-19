import type { FixtureGroundTruth } from "../types";

/**
 * Seguin Residence — secondary canonical fixture. Same shape as
 * Musgrave (same Grand County jurisdiction) so the runner exercises
 * the corpus from two independent project contexts on the same code
 * set. Useful for surfacing non-determinism across submissions that
 * should retrieve identical code.
 *
 * Engagement + submission ids match `lib/db/src/seed.ts`.
 */
export const seguinFixture: FixtureGroundTruth = {
  key: "seguin",
  label: "Seguin Residence (Grand County, UT)",
  jurisdictionKey: "grand_county_ut",
  // Seeded engagement id from lib/db/src/seed.ts:32
  engagementId: "00000000-0000-4000-9000-000000000001",
  // Seeded submission id from lib/db/src/seed.ts:71
  submissionId: "00000000-0000-4000-8000-000000000001",
  expectedFindings: [],
  retrievalQueries: [
    {
      id: "seguin-q01",
      jurisdictionKey: "grand_county_ut",
      question:
        "Egress widths for exterior doors in single-family residential — IBC 1010",
      // Submission note in seed.ts:80 references IBC 1010 explicitly,
      // so the engine should retrieve an atom tagged with that
      // section number when the corpus contains it. Will likely miss
      // on current corpus (IRC-focused, not IBC) — that miss is the
      // signal.
      expectedSectionNumber: "1010",
    },
    {
      id: "seguin-q02",
      jurisdictionKey: "grand_county_ut",
      question: "Required setbacks for residential zoning",
      expectedSectionNumber: "5.4",
    },
  ],
};
