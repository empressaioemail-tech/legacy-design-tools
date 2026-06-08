#!/usr/bin/env node
/**
 * Seed Layer-1 FBC + NEC interim deep-link reference atoms for Florida jurisdictions.
 * Run: node scripts/seed-florida-interim-atoms.mjs
 * Requires DATABASE_URL.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";

const FLORIDA_KEYS = ["miami_beach_fl", "miami_dade_fl"];
const SOURCE_NAME = "florida_interim_reference";

const FBC = [
  ["FBC-M601.6", "Mechanical — duct insulation and sealing", "FBC_MECHANICAL", "https://codes.iccsafe.org/content/FLMECH2023P1", "ungrounded-pending-ICC"],
  ["FBC-M Ch.4", "Mechanical — ventilation and exhaust", "FBC_MECHANICAL", "https://codes.iccsafe.org/content/FLMECH2023P1/chapter-4-ventilation", "ungrounded-pending-ICC"],
  ["FBC-304.11", "Building — mechanical equipment access", "FBC_RESIDENTIAL", "https://codes.iccsafe.org/content/FLRC2023P1/chapter-3-building-planning", "ungrounded-pending-ICC"],
  ["FBC-M307", "Mechanical — condensate disposal", "FBC_MECHANICAL", "https://codes.iccsafe.org/content/FLMECH2023P1", "ungrounded-pending-ICC"],
  ["FBC EC R103", "Energy — scope", "FBC_ENERGY", "https://codes.iccsafe.org/content/FLECC2023P1", "ungrounded-pending-ICC"],
  ["FBC EC R403.7.1", "Energy — HVAC duct sealing", "FBC_ENERGY", "https://codes.iccsafe.org/content/FLECC2023P1", "ungrounded-pending-ICC"],
  ["FBC E-403.6", "Electrical — branch circuits", "FBC_ELECTRICAL", "https://codes.iccsafe.org/content/FLELE2023P1", "ungrounded-pending-ICC"],
  ["FBCB Ch.7", "Building — fire-resistance assemblies", "FBC_BUILDING", "https://codes.iccsafe.org/content/FLBC2023P1/chapter-7-fire-and-smoke-protection-features", "ungrounded-pending-ICC"],
  ["FBCB Table 721.1(2)", "Building — fire-resistance table", "FBC_BUILDING", "https://codes.iccsafe.org/content/FLBC2023P1/chapter-7-fire-and-smoke-protection-features", "ungrounded-pending-ICC"],
  ["FBCB 1405.4", "Building — exterior wall coverings (NOA/BORA)", "FBC_BUILDING", "https://codes.iccsafe.org/content/FLBC2023P1/chapter-14-exterior-walls", "ungrounded-pending-ICC"],
];

const NEC = [
  ["NEC Art. 110", "General requirements", "NEC", "https://www.nfpa.org/codes-and-standards/nfpa-70-nec", "ungrounded-pending-NFPA"],
  ["NEC Art. 210", "Branch circuits", "NEC", "https://www.nfpa.org/codes-and-standards/nfpa-70-nec", "ungrounded-pending-NFPA"],
  ["NEC Art. 220", "Load calculations", "NEC", "https://www.nfpa.org/codes-and-standards/nfpa-70-nec", "ungrounded-pending-NFPA"],
  ["NEC Art. 408", "Panelboards and schedules", "NEC", "https://www.nfpa.org/codes-and-standards/nfpa-70-nec", "ungrounded-pending-NFPA"],
];

function hash(parts) {
  return createHash("sha256").update(parts.join("\x1f")).digest("hex");
}

function bodyFor(section, flag) {
  const tag = flag === "ungrounded-pending-ICC" ? "ICC" : "NFPA";
  return `Interim reference (${flag}): ${section}. Full normative text via ${tag} free viewer — not grounded in corpus.`;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL required");
  const sql = postgres(url);

  const [src] = await sql`
    INSERT INTO code_atom_sources (source_name, label, source_type, license_type, base_url, notes)
    VALUES (
      ${SOURCE_NAME},
      'Florida Layer-1 interim deep-link references',
      'reference',
      'deep_link_only',
      'https://codes.iccsafe.org',
      'ADR-019 interim footing — seeded, not fetched'
    )
    ON CONFLICT (source_name) DO UPDATE SET label = EXCLUDED.label
    RETURNING id
  `;
  const sourceId = src.id;
  let written = 0;

  for (const jKey of FLORIDA_KEYS) {
    for (const [section, title, book, sourceUrl, flag] of [...FBC, ...NEC]) {
      const edition = book.startsWith("NEC") ? "NEC 2020" : "FBC 8th Ed. (2023)";
      const b = bodyFor(section, flag);
      const contentHash = hash([jKey, book, edition, section, b, flag]);
      const ins = await sql`
        INSERT INTO code_atoms (
          source_id, jurisdiction_key, code_book, edition,
          section_number, section_title, body, content_hash, source_url, metadata
        ) VALUES (
          ${sourceId}, ${jKey}, ${book}, ${edition},
          ${section}, ${title}, ${b}, ${contentHash}, ${sourceUrl},
          ${sql.json({ accessPolicy: "platform-internal", groundingFlag: flag, layer: 1, interimDeepLink: true })}
        )
        ON CONFLICT (content_hash) DO NOTHING
        RETURNING id
      `;
      if (ins.length > 0) written++;
    }
  }

  console.log(JSON.stringify({ sourceId, jurisdictions: FLORIDA_KEYS, atomsWritten: written }));
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
