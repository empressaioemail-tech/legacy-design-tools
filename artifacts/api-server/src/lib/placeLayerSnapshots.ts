/**
 * Permanent place-layer archive for Property Brief.
 * Complements 24h adapter_response_cache (same-day hot path).
 */

import { db, placeLayerSnapshots } from "@workspace/db";
import type { AdapterResult } from "@workspace/adapters";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  placeKeyFromCoords,
  roundPlaceCoord,
  formatPlaceCoord,
  contentHashForPayload,
  extractLlUuidFromPayload,
} from "./placeLayerUtils";

export {
  placeKeyFromCoords,
  contentHashForPayload,
  extractLlUuidFromPayload,
} from "./placeLayerUtils";

export async function readPlaceLayerSnapshot(input: {
  adapterKey: string;
  latitude: number;
  longitude: number;
  placeKey?: string;
}): Promise<{
  payload: Record<string, unknown>;
  snapshotAt: string;
  llUuid: string | null;
  contentHash: string;
} | null> {
  try {
    const lat = roundPlaceCoord(input.latitude);
    const lng = roundPlaceCoord(input.longitude);
    const placeKey = input.placeKey ?? placeKeyFromCoords(lat, lng);
    let rows = await db
      .select()
      .from(placeLayerSnapshots)
      .where(
        and(
          eq(placeLayerSnapshots.adapterKey, input.adapterKey),
          eq(placeLayerSnapshots.placeKey, placeKey),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      rows = await db
        .select()
        .from(placeLayerSnapshots)
        .where(
          and(
            eq(placeLayerSnapshots.adapterKey, input.adapterKey),
            eq(placeLayerSnapshots.latRounded, formatPlaceCoord(lat)),
            eq(placeLayerSnapshots.lngRounded, formatPlaceCoord(lng)),
          ),
        )
        .limit(1);
    }
    const row = rows[0];
    if (!row) return null;
    const payload = row.payloadJson as Record<string, unknown>;
    return {
      payload,
      snapshotAt: row.snapshotAt.toISOString(),
      llUuid: row.llUuid,
      contentHash: row.contentHash,
    };
  } catch (err) {
    logger.warn({ err, adapterKey: input.adapterKey }, "placeLayer: read failed");
    return null;
  }
}

export async function writePlaceLayerSnapshot(input: {
  adapterKey: string;
  latitude: number;
  longitude: number;
  result: AdapterResult;
  placeKey?: string;
}): Promise<void> {
  try {
    const lat = roundPlaceCoord(input.latitude);
    const lng = roundPlaceCoord(input.longitude);
    const payload = input.result.payload as Record<string, unknown>;
    const llUuid =
      input.adapterKey.startsWith("regrid:")
        ? extractLlUuidFromPayload(payload)
        : null;
    const placeKey =
      llUuid != null ? `ll:${llUuid}` : (input.placeKey ?? placeKeyFromCoords(lat, lng));
    const contentHash = contentHashForPayload(payload);
    const now = new Date();
    await db
      .insert(placeLayerSnapshots)
      .values({
        placeKey,
        adapterKey: input.adapterKey,
        latRounded: formatPlaceCoord(lat),
        lngRounded: formatPlaceCoord(lng),
        llUuid,
        payloadJson: payload,
        contentHash,
        snapshotAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          placeLayerSnapshots.adapterKey,
          placeLayerSnapshots.placeKey,
        ],
        set: {
          latRounded: formatPlaceCoord(lat),
          lngRounded: formatPlaceCoord(lng),
          llUuid,
          payloadJson: payload,
          contentHash,
          snapshotAt: now,
          updatedAt: now,
        },
      });
  } catch (err) {
    logger.warn(
      { err, adapterKey: input.adapterKey },
      "placeLayer: write failed",
    );
  }
}
