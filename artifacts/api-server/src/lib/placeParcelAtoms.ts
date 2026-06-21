/**
 * Decision 6 — uncapped parcel→atoms read surface for spine console E7.
 */

import { eq } from "drizzle-orm";
import {
  db,
  reasoningAtoms,
  atomCalibrationOverlay,
} from "@workspace/db";
import {
  retrieveAtomsForQuestion,
  keyFromEngagement,
  canonicalOverlayAtomKey,
  type RetrievedAtom,
} from "@workspace/codes";
import { BROKERAGE_CODE_QUERIES } from "./brokerageCodeQueries";
import { resolveJurisdictionTenant } from "./atomAdjudicationEvidenceLedger";

export interface PlaceAtomEntry {
  atomId: string;
  kind: "code-section" | "reasoning";
  label: string;
  snippet: string | null;
  edition: string | null;
  codeRef: string | null;
  overlay?: {
    assertedConfidence: number | null;
    calibratedConfidence: number | null;
    signalCount: number | null;
    calibrationStale: boolean | null;
  };
  citation: {
    source: string;
    asOf: string;
  };
}

export interface PlaceAtomsBody {
  placeKey: string;
  jurisdictionKey: string | null;
  atomCount: number;
  atoms: PlaceAtomEntry[];
}

function atomEntryFromRetrieved(
  atom: RetrievedAtom,
  query: string,
): PlaceAtomEntry {
  const atomId = canonicalOverlayAtomKey(atom.id);
  return {
    atomId,
    kind: atom.id.startsWith("reasoning:") ? "reasoning" : "code-section",
    label: atom.sectionTitle?.trim() || atom.sectionNumber || atomId,
    snippet: atom.body?.trim().slice(0, 400) || null,
    edition: atom.edition ?? null,
    codeRef: atom.sectionNumber ?? null,
    citation: {
      source: atom.sourceName ?? "code_atoms",
      asOf: new Date().toISOString(),
    },
  };
}

async function overlayForAtom(
  atomId: string,
  jurisdictionKey: string | null,
): Promise<PlaceAtomEntry["overlay"] | undefined> {
  if (!jurisdictionKey) return undefined;
  const tenant = resolveJurisdictionTenant({
    cortexJurisdictionKey: jurisdictionKey,
    jurisdictionCity: null,
    jurisdictionState: null,
    jurisdiction: null,
    address: null,
  });
  if (!tenant) return undefined;

  const rows = await db
    .select({
      assertedConfidence: atomCalibrationOverlay.assertedConfidence,
      calibratedConfidence: atomCalibrationOverlay.calibratedConfidence,
      signalCount: atomCalibrationOverlay.signalCount,
      calibrationStale: atomCalibrationOverlay.calibrationStale,
    })
    .from(atomCalibrationOverlay)
    .where(eq(atomCalibrationOverlay.atomId, atomId))
    .limit(1);

  const row = rows[0];
  if (!row) return undefined;
  return {
    assertedConfidence:
      row.assertedConfidence == null ? null : Number(row.assertedConfidence),
    calibratedConfidence:
      row.calibratedConfidence == null ? null : Number(row.calibratedConfidence),
    signalCount: row.signalCount ?? null,
    calibrationStale: row.calibrationStale ?? null,
  };
}

export async function buildPlaceParcelAtoms(args: {
  placeKey: string;
  jurisdictionKey: string | null;
  address?: string;
}): Promise<PlaceAtomsBody> {
  const seen = new Set<string>();
  const atoms: PlaceAtomEntry[] = [];

  if (args.jurisdictionKey) {
    for (const query of BROKERAGE_CODE_QUERIES) {
      const hits = await retrieveAtomsForQuestion({
        jurisdictionKey: args.jurisdictionKey,
        question: query,
        limit: 50,
      });
      for (const atom of hits) {
        const entry = atomEntryFromRetrieved(atom, query);
        if (seen.has(entry.atomId)) continue;
        seen.add(entry.atomId);
        entry.overlay = await overlayForAtom(entry.atomId, args.jurisdictionKey);
        atoms.push(entry);
      }
    }

    const reasoningRows = await db
      .select({
        id: reasoningAtoms.id,
        codeRef: reasoningAtoms.codeRef,
        edition: reasoningAtoms.edition,
        assertedConfidence: reasoningAtoms.assertedConfidence,
      })
      .from(reasoningAtoms)
      .where(eq(reasoningAtoms.jurisdictionKey, args.jurisdictionKey))
      .limit(500);

    for (const row of reasoningRows) {
      const atomId = canonicalOverlayAtomKey(row.id);
      if (seen.has(atomId)) continue;
      seen.add(atomId);
      atoms.push({
        atomId,
        kind: "reasoning",
        label: row.codeRef,
        snippet: null,
        edition: row.edition,
        codeRef: row.codeRef,
        overlay: await overlayForAtom(atomId, args.jurisdictionKey),
        citation: {
          source: "reasoning_atoms",
          asOf: new Date().toISOString(),
        },
      });
    }
  }

  return {
    placeKey: args.placeKey,
    jurisdictionKey: args.jurisdictionKey,
    atomCount: atoms.length,
    atoms,
  };
}

export function jurisdictionKeyFromPlaceContext(input: {
  city?: string | null;
  state?: string | null;
  address?: string;
}): string | null {
  return keyFromEngagement({
    jurisdictionCity: input.city ?? null,
    jurisdictionState: input.state ?? null,
    jurisdiction: null,
    address: input.address ?? null,
  });
}
