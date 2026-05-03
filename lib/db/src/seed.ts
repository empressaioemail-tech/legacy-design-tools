import { db, pool } from "./index";
import { engagements, submissions, users } from "./schema";

/**
 * Seed dev user profiles so the engagement-timeline display-name
 * lookup resolves the placeholder ids the dev `pr_session` cookie
 * carries (e.g. `u1`, `u2`). Production identity will be sourced
 * from the real auth layer when it lands; this is just so the
 * timeline UI does not show "Unknown user" against every event in
 * a fresh dev DB.
 */
const seedUsers: Array<{
  id: string;
  displayName: string;
  email?: string;
}> = [
  { id: "u1", displayName: "Alex Reviewer", email: "alex@example.com" },
  { id: "u2", displayName: "Jamie Architect", email: "jamie@example.com" },
];

/**
 * Stable engagement ids let us:
 *  - reseed idempotently via `onConflictDoNothing({ target: engagements.id })`
 *    (the table's name_lower index is non-unique post A04.7, so it
 *    cannot serve as a conflict target).
 *  - reference the same engagement by id from {@link seedSubmissions}
 *    below without a name lookup, so the seeded submission rows
 *    always join cleanly to the seeded engagements.
 */
const seedData = [
  {
    id: "00000000-0000-4000-9000-000000000001",
    name: "Seguin Residence",
    nameLower: "seguin residence",
    jurisdiction: "Moab, UT",
    address: "1421 Seguin St, Moab, UT 84532",
    applicantFirm: "Civic Design LLC",
    status: "active",
  },
  {
    id: "00000000-0000-4000-9000-000000000002",
    name: "Musgrave Residence",
    nameLower: "musgrave residence",
    jurisdiction: "Moab, UT",
    address: "287 Musgrave Ln, Moab, UT 84532",
    applicantFirm: "Atlas Architects",
    status: "active",
  },
];

/**
 * Seed at least one pending submission so a freshly-seeded dev DB
 * satisfies the QA `plan-review-smoke / load-inbox` checklist item:
 * opening `/plan-review/` lands on a populated reviewer Inbox
 * instead of an empty queue. Each row is keyed by a stable UUID so
 * reseeding is idempotent (`onConflictDoNothing` on the primary
 * key) and is attached directly to the seeded engagements via
 * their stable ids above so the join in `GET /api/reviewer/queue`
 * returns a complete
 * row (engagement name, jurisdiction, applicantFirm, submittedAt,
 * status, note).
 */
const seedSubmissions: Array<{
  id: string;
  engagementId: string;
  jurisdiction: string;
  hoursAgo: number;
  note: string;
}> = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    engagementId: "00000000-0000-4000-9000-000000000001",
    jurisdiction: "Moab, UT",
    hoursAgo: 6,
    note: "Initial 100% CD package — please confirm exterior egress widths against IBC 1010.",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    engagementId: "00000000-0000-4000-9000-000000000002",
    jurisdiction: "Moab, UT",
    hoursAgo: 30,
    note: "Re-submission addressing zoning setback comments from prior round.",
  },
];

async function main() {
  console.log("Seeding users…");
  for (const u of seedUsers) {
    await db
      .insert(users)
      .values(u)
      .onConflictDoNothing({ target: users.id });
    console.log(`  ✓ ${u.displayName} (${u.id})`);
  }
  console.log("Seeding engagements…");
  for (const e of seedData) {
    // `engagements.name_lower` is a non-unique index (post A04.7 —
    // two distinct Revit projects can legitimately share a name), so
    // we can't use it as a conflict target. Use the primary key
    // instead, which works because each seed row carries a stable
    // id above.
    await db
      .insert(engagements)
      .values(e)
      .onConflictDoNothing({ target: engagements.id });
    console.log(`  ✓ ${e.name}`);
  }
  console.log("Seeding submissions…");
  for (const s of seedSubmissions) {
    const submittedAt = new Date(Date.now() - s.hoursAgo * 60 * 60 * 1000);
    await db
      .insert(submissions)
      .values({
        id: s.id,
        engagementId: s.engagementId,
        jurisdiction: s.jurisdiction,
        note: s.note,
        status: "pending",
        submittedAt,
        createdAt: submittedAt,
      })
      .onConflictDoNothing({ target: submissions.id });
    console.log(`  ✓ submission ${s.id}`);
  }
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
