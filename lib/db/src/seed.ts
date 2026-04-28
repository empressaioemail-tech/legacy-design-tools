import { db, pool } from "./index";
import { engagements } from "./schema";

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
