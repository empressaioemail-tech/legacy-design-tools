import { db, pool } from "./index";
import { engagements, users } from "./schema";

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

const seedData = [
  {
    name: "Seguin Residence",
    nameLower: "seguin residence",
    jurisdiction: "Moab, UT",
    address: "1421 Seguin St, Moab, UT 84532",
    status: "active",
  },
  {
    name: "Musgrave Residence",
    nameLower: "musgrave residence",
    jurisdiction: "Moab, UT",
    address: "287 Musgrave Ln, Moab, UT 84532",
    status: "active",
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
    await db
      .insert(engagements)
      .values(e)
      .onConflictDoNothing({ target: engagements.nameLower });
    console.log(`  ✓ ${e.name}`);
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
