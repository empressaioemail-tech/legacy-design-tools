#!/usr/bin/env node
/**
 * Seed the G-56 Smart Files data room on cortex-prod (planner-owned --apply).
 *
 * Produces:
 *   - 2 folders (jurisdiction + site)
 *   - 3 file-shaped documents (platform-internal)
 *   - 1 document placed in BOTH folders (same entityId, two placement edges)
 *   - 1 PDF-bearing document (minimal PDF blob written to seed-blobs/)
 *   - 1 non-file record atom on folder 1 (record pane only)
 *   - 1 typed absence (absent-verified)
 *   - 1 tenant-private document for RBAC probe (deny anon)
 *
 * Usage:
 *   node scripts/seedSmartFilesDataRoom.mjs [--dry-run] [--backdate-computed-at ISO]
 *
 * Does NOT take the atoms bulk-writer slot. Named, small writes only.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRY_RUN = process.argv.includes("--dry-run");
const backdateIdx = process.argv.indexOf("--backdate-computed-at");
const BACKDATE_ISO =
  backdateIdx >= 0 ? process.argv[backdateIdx + 1] : null;

/** Smallest valid PDF (one empty page). */
const MINIMAL_PDF = Buffer.from(
  "%PDF-1.1\n1 0 obj<<>>endobj\n2 0 obj<</Length 44>>stream\nBT /F1 12 Tf 100 700 Td (G-56 seed) Tj ET\nendstream\nendobj\n3 0 obj<</Type/Page/Parent 4 0 R/MediaBox[0 0 612 792]/Contents 2 0 R>>endobj\n4 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\nxref\n0 5\n0000000000 65535 f\n0000000009 00000 n\n0000000052 00000 n\n0000000145 00000 n\n0000000244 00000 n\ntrailer<</Size 5/Root 4 0 R>>\nstartxref\n312\n%%EOF",
  "utf8",
);

const FOLDER_JURISDICTION = "folder:jurisdiction:48021:planning";
const FOLDER_SITE = "folder:site:parcel:48021:R12345:geotech";

const DOC_UDC = {
  scopeType: "jurisdiction",
  scopeId: "48021",
  docSlug: "udc-seed",
  title: "UDC Seed Document",
};
const DOC_SOP = {
  scopeType: "jurisdiction",
  scopeId: "48021",
  docSlug: "council-sop-seed",
  title: "Council SOP Seed",
};
const DOC_GEOTECH = {
  scopeType: "site",
  scopeId: "parcel:48021:R12345",
  docSlug: "geotech-report",
  title: "Geotech Report Seed",
};
const DOC_PRIVATE = {
  scopeType: "jurisdiction",
  scopeId: "48021",
  docSlug: "tenant-private-probe",
  title: "Tenant Private RBAC Probe",
};

const PROVENANCE = {
  sourceUri: "https://example.gov/smart-files-seed",
  sourceLabel: "G-56 seed script",
  retrievedAt: new Date().toISOString(),
  sourceVintage: "2026-08-15",
};

async function main() {
  const { db, smartFileFolders, smartFileFolderRecords } = await import(
    "@workspace/db"
  );
  const {
    buildSmartFileEntityId,
  } = await import("../src/atoms/smart-file.contract.ts");
  const {
    createDocument,
    placeDocument,
    recordAbsenceDetermination,
  } = await import("../src/lib/smartFileStore.ts");

  const computedAt = BACKDATE_ISO ? new Date(BACKDATE_ISO) : new Date();
  const pdfCid = "bafyG56seedpdf0001";
  const blobDir = join(__dirname, "..", "seed-blobs", "smart-files");
  if (!DRY_RUN) {
    mkdirSync(blobDir, { recursive: true });
    writeFileSync(join(blobDir, `${pdfCid}.bin`), MINIMAL_PDF);
  }

  console.log("G-56 Smart Files data room seed", DRY_RUN ? "(dry-run)" : "");

  const folderRows = [
    {
      folderId: FOLDER_JURISDICTION,
      scopeType: "jurisdiction",
      scopeId: "48021",
      label: "Bastrop County Planning",
      accessPolicy: "platform-internal",
      parentFolderId: null,
    },
    {
      folderId: FOLDER_SITE,
      scopeType: "site",
      scopeId: "parcel:48021:R12345",
      label: "Parcel R12345 Geotech",
      accessPolicy: "platform-internal",
      parentFolderId: FOLDER_JURISDICTION,
    },
  ];

  if (!DRY_RUN) {
    for (const f of folderRows) {
      await db
        .insert(smartFileFolders)
        .values(f)
        .onConflictDoNothing();
    }
  }

  const entityUdc = buildSmartFileEntityId(DOC_UDC);
  const entitySop = buildSmartFileEntityId(DOC_SOP);
  const entityGeotech = buildSmartFileEntityId(DOC_GEOTECH);
  const entityPrivate = buildSmartFileEntityId(DOC_PRIVATE);

  if (!DRY_RUN) {
    await createDocument({
      ...DOC_UDC,
      accessPolicy: "platform-internal",
      contentCid: pdfCid,
      contentType: "application/pdf",
      byteSize: MINIMAL_PDF.length,
      provenance: PROVENANCE,
      computedAt,
    });
    await createDocument({
      ...DOC_SOP,
      accessPolicy: "platform-internal",
      contentCid: "bafyG56seedsop0002",
      contentType: "application/pdf",
      byteSize: 512,
      provenance: PROVENANCE,
    });
    await createDocument({
      ...DOC_GEOTECH,
      accessPolicy: "platform-internal",
      contentCid: "bafyG56seedgeo0003",
      contentType: "application/pdf",
      byteSize: 768,
      provenance: PROVENANCE,
    });
    await createDocument({
      ...DOC_PRIVATE,
      accessPolicy: "tenant-private",
      contentCid: "bafyG56seedpriv004",
      contentType: "application/pdf",
      byteSize: 256,
      provenance: PROVENANCE,
    });

    // Dual-folder same entityId: UDC in both folders
    await placeDocument({
      entityId: entityUdc,
      targetType: "folder",
      targetId: FOLDER_JURISDICTION,
      placedBy: "seedSmartFilesDataRoom",
    });
    await placeDocument({
      entityId: entityUdc,
      targetType: "folder",
      targetId: FOLDER_SITE,
      placedBy: "seedSmartFilesDataRoom",
    });
    await placeDocument({
      entityId: entitySop,
      targetType: "folder",
      targetId: FOLDER_JURISDICTION,
      placedBy: "seedSmartFilesDataRoom",
    });
    await placeDocument({
      entityId: entityGeotech,
      targetType: "folder",
      targetId: FOLDER_SITE,
      placedBy: "seedSmartFilesDataRoom",
    });

    await recordAbsenceDetermination({
      scopeType: "jurisdiction",
      scopeId: "48021",
      docSlug: "str-ordinance",
      verdict: "absent-verified",
      basis:
        "Consulted Bastrop County code index and clerk records; no short-term-rental ordinance on file as of seed date.",
      determinedBy: "seedSmartFilesDataRoom",
      sourceUri: "https://example.gov/bastrop/code-index",
      accessPolicy: "platform-internal",
    });

    await db.insert(smartFileFolderRecords).values({
      folderId: FOLDER_JURISDICTION,
      recordEntityId: "property:flood-zone:48021:R12345",
      entityType: "flood-hazard-zone",
      accessPolicy: "platform-internal",
      payload: {
        entityType: "flood-hazard-zone",
        entityId: "property:flood-zone:48021:R12345",
        title: "FEMA SFHA determination (seed)",
        accessPolicy: "platform-internal",
        source: "seedSmartFilesDataRoom",
        computedAt: computedAt.toISOString(),
        claim: "Zone X (outside SFHA) — seed record for record pane",
      },
    }).onConflictDoNothing();
  }

  console.log(JSON.stringify({
    folders: 2,
    fileDocuments: 3,
    dualPlacedEntityId: entityUdc,
    pdfCid,
    typedAbsenceSlug: "str-ordinance",
    recordPaneEntityId: "property:flood-zone:48021:R12345",
    tenantPrivateProbe: entityPrivate,
    backdate: BACKDATE_ISO ?? null,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
