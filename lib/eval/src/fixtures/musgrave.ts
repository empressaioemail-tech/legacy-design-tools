import type { FixtureGroundTruth } from "../types";

/**
 * Musgrave Residence — primary canonical fixture. Engagement +
 * submission ids match the stable UUIDs seeded by `lib/db/src/seed.ts`
 * so a freshly-seeded dev DB satisfies this fixture without extra
 * setup.
 *
 * Ground-truth shape (v1, light): zero `expectedFindings` — Musgrave
 * has no captured reviewer comment set. The fixture instead exercises
 * citation-validity (every citation the engine emits must resolve)
 * and the Grand County retrieval queries below.
 *
 * Promotion path: when Nick (or an inspector) does a real plan-review
 * pass on Musgrave and produces a list of comments, those become the
 * `expectedFindings` array. Until then, the recall scorer returns
 * `notApplicable: true` and the runner records cost + latency only.
 */
export const musgraveFixture: FixtureGroundTruth = {
  key: "musgrave",
  label: "Musgrave Residence (Grand County, UT)",
  jurisdictionKey: "grand_county_ut",
  // Seeded engagement id from lib/db/src/seed.ts:41
  engagementId: "00000000-0000-4000-9000-000000000002",
  // Seeded submission id from lib/db/src/seed.ts:78
  submissionId: "00000000-0000-4000-8000-000000000002",
  expectedFindings: [],
  retrievalQueries: [
    {
      id: "musgrave-q01",
      jurisdictionKey: "grand_county_ut",
      question:
        "What is the required residential setback for a single-family lot in Grand County?",
      // Section-number signal — independent of which atom id the
      // jurisdiction's corpus assigns (corpus id schemes are not
      // stable across re-ingestion runs). Surfaces the
      // section-number lookup component without coupling to an id
      // that will drift.
      expectedSectionNumber: "5.4",
    },
    {
      id: "musgrave-q02",
      jurisdictionKey: "grand_county_ut",
      question: "Yard setbacks definitions in the Land Use Code",
      expectedSectionNumber: "5.6",
    },
    {
      id: "musgrave-q03",
      jurisdictionKey: "grand_county_ut",
      question:
        "What are the snow load requirements for residential construction?",
      // IRC R301.2.1 corpus is loaded per 42 §Current state line 39
      // (479 atoms on helium dev). Section-number target.
      expectedSectionNumber: "R301.2.1",
    },
  ],
};
