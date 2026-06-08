/**
 * Layer-1 interim deep-link reference atoms (ADR-019).
 *
 * FBC/I-Code sections carry `ungrounded-pending-ICC`; NEC articles carry
 * `ungrounded-pending-NFPA`. No verbatim normative text — structure +
 * reasoning + publisher deep-link only.
 */

import { createHash } from "node:crypto";
import type { NewCodeAtom } from "@workspace/db";

export interface InterimReferenceAtomDef {
  sectionNumber: string;
  sectionTitle: string;
  body: string;
  sourceUrl: string;
  codeBook: string;
  edition: string;
  groundingFlag: "ungrounded-pending-ICC" | "ungrounded-pending-NFPA";
}

/** FBC / Florida Building Code interim references (ICC deep-link footing). */
export const FBC_INTERIM_ATOMS: ReadonlyArray<InterimReferenceAtomDef> = [
  {
    sectionNumber: "FBC-M601.6",
    sectionTitle: "Mechanical — duct insulation and sealing",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Mechanical §601.6 addresses duct insulation and sealing requirements for HVAC distribution. Verify sealed/insulated return and supply ductwork against the adopted FBC Mechanical edition. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLMECH2023P1",
    codeBook: "FBC_MECHANICAL",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC-M Ch.4",
    sectionTitle: "Mechanical — ventilation and exhaust",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Mechanical Chapter 4 covers ventilation, exhaust, and outdoor-air requirements including balanced return-air provisions for dwelling units. Review mechanical plans for compliant return-air sizing and distribution. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLMECH2023P1/chapter-4-ventilation",
    codeBook: "FBC_MECHANICAL",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC-304.11",
    sectionTitle: "Building — mechanical equipment access",
    body:
      "Interim reference (ungrounded-pending-ICC): IRC/FBC §304.11 requires access and working space for mechanical equipment. Confirm plan details show compliant access to air handlers, condensers, and related equipment. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLRC2023P1/chapter-3-building-planning",
    codeBook: "FBC_RESIDENTIAL",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC-M307",
    sectionTitle: "Mechanical — condensate disposal",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Mechanical §M307 governs condensate disposal from cooling equipment. Verify drain routing, trap details, and termination on mechanical sheets. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLMECH2023P1",
    codeBook: "FBC_MECHANICAL",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC EC R103",
    sectionTitle: "Energy — scope and general requirements",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Energy Conservation R103 establishes scope and compliance paths for residential energy provisions. Cross-check HVAC load documentation and equipment efficiencies. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLECC2023P1",
    codeBook: "FBC_ENERGY",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC EC R403.7.1",
    sectionTitle: "Energy — HVAC duct sealing and insulation",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Energy Conservation R403.7.1 addresses duct sealing, insulation, and testing for residential systems. Confirm Manual J/D documentation and duct leakage assumptions on the calc set. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLECC2023P1",
    codeBook: "FBC_ENERGY",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBC E-403.6",
    sectionTitle: "Electrical — branch-circuit and panelboard provisions",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Electrical §E403.6 (aligned with NEC branch-circuit requirements) governs branch circuits serving dwelling units. Cross-reference electrical sheets and panel schedules. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLELE2023P1",
    codeBook: "FBC_ELECTRICAL",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBCB Ch.7",
    sectionTitle: "Building — fire-resistance-rated assemblies",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Building Chapter 7 covers fire-resistance-rated assemblies and opening protectives. Review wall/floor ratings on life-safety and architectural sheets. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLBC2023P1/chapter-7-fire-and-smoke-protection-features",
    codeBook: "FBC_BUILDING",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBCB Table 721.1(2)",
    sectionTitle: "Building — fire-resistance ratings (Table 721.1(2))",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Building Table 721.1(2) lists fire-resistance ratings for wall and floor assemblies. Verify rated assembly designations on plans match table selections. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLBC2023P1/chapter-7-fire-and-smoke-protection-features",
    codeBook: "FBC_BUILDING",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
  {
    sectionNumber: "FBCB 1405.4",
    sectionTitle: "Building — exterior wall coverings (wind / NOA)",
    body:
      "Interim reference (ungrounded-pending-ICC): FBC Building §1405.4 addresses exterior wall coverings and product approval in wind-borne debris regions. Confirm NOA/BORA product approvals and wind-load design criteria for Miami-Dade. Full normative text: Florida Building Code viewer (ICC).",
    sourceUrl: "https://codes.iccsafe.org/content/FLBC2023P1/chapter-14-exterior-walls",
    codeBook: "FBC_BUILDING",
    edition: "FBC 8th Ed. (2023)",
    groundingFlag: "ungrounded-pending-ICC",
  },
];

/** NEC interim references (NFPA free-access deep-link footing). */
export const NEC_INTERIM_ATOMS: ReadonlyArray<InterimReferenceAtomDef> = [
  {
    sectionNumber: "NEC Art. 110",
    sectionTitle: "General — requirements for electrical installations",
    body:
      "Interim reference (ungrounded-pending-NFPA): NEC Article 110 establishes general requirements for electrical installations including working space, identification, and equipment suitability. Cross-check electrical sheets for compliant panel/working clearances. Full normative text: NFPA free-access NEC viewer.",
    sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
    codeBook: "NEC",
    edition: "NEC 2020",
    groundingFlag: "ungrounded-pending-NFPA",
  },
  {
    sectionNumber: "NEC Art. 210",
    sectionTitle: "Branch circuits",
    body:
      "Interim reference (ungrounded-pending-NFPA): NEC Article 210 governs branch-circuit ratings, outlets, and dwelling-unit provisions. Verify branch-circuit sizing and outlet spacing on electrical plans. Full normative text: NFPA free-access NEC viewer.",
    sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
    codeBook: "NEC",
    edition: "NEC 2020",
    groundingFlag: "ungrounded-pending-NFPA",
  },
  {
    sectionNumber: "NEC Art. 220",
    sectionTitle: "Load calculations",
    body:
      "Interim reference (ungrounded-pending-NFPA): NEC Article 220 requires documented load calculations for service and feeder sizing. Confirm panel schedules and load calc worksheets support service/feeder ampacity. Full normative text: NFPA free-access NEC viewer.",
    sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
    codeBook: "NEC",
    edition: "NEC 2020",
    groundingFlag: "ungrounded-pending-NFPA",
  },
  {
    sectionNumber: "NEC Art. 408",
    sectionTitle: "Panelboards and schedules",
    body:
      "Interim reference (ungrounded-pending-NFPA): NEC Article 408 requires panelboard labeling, circuit identification, and coordinated panel schedules. Electrical sheets must show complete panel schedules with breaker sizes and load documentation. Full normative text: NFPA free-access NEC viewer.",
    sourceUrl: "https://www.nfpa.org/codes-and-standards/nfpa-70-nec",
    codeBook: "NEC",
    edition: "NEC 2020",
    groundingFlag: "ungrounded-pending-NFPA",
  },
];

export const FLORIDA_INTERIM_JURISDICTION_KEYS = [
  "miami_beach_fl",
  "miami_dade_fl",
] as const;

function interimContentHash(
  jurisdictionKey: string,
  def: InterimReferenceAtomDef,
): string {
  const payload = [
    jurisdictionKey,
    def.codeBook,
    def.edition,
    def.sectionNumber,
    def.body,
    def.groundingFlag,
  ].join("\x1f");
  return createHash("sha256").update(payload).digest("hex");
}

/** Project interim atom defs into `code_atoms` insert rows. */
export function buildInterimAtomRows(
  sourceId: string,
  jurisdictionKey: string,
  defs: ReadonlyArray<InterimReferenceAtomDef>,
): NewCodeAtom[] {
  const now = new Date();
  return defs.map((def) => ({
    sourceId,
    jurisdictionKey,
    codeBook: def.codeBook,
    edition: def.edition,
    sectionNumber: def.sectionNumber,
    sectionTitle: def.sectionTitle,
    parentSection: null,
    body: def.body,
    bodyHtml: null,
    embedding: null,
    embeddingModel: null,
    embeddedAt: null,
    contentHash: interimContentHash(jurisdictionKey, def),
    sourceUrl: def.sourceUrl,
    fetchedAt: now,
    metadata: {
      accessPolicy: "platform-internal",
      groundingFlag: def.groundingFlag,
      layer: 1,
      interimDeepLink: true,
    },
  }));
}

export function allInterimAtomDefs(): InterimReferenceAtomDef[] {
  return [...FBC_INTERIM_ATOMS, ...NEC_INTERIM_ATOMS];
}
