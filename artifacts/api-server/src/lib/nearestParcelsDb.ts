import pg from "pg";
import type { NearestParcelsQueryable } from "./txgioNearestParcels";

let sharedPool: pg.Pool | null = null;
let injected: NearestParcelsQueryable | null | undefined;

export function setNearestParcelsQueryableForTests(
  queryable: NearestParcelsQueryable | null,
): void {
  injected = queryable;
}

export function resetNearestParcelsQueryableForTests(): void {
  injected = undefined;
}

export function nearestParcelsQueryableFromEnv(): NearestParcelsQueryable | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
  }
  return sharedPool;
}

export function resolveNearestParcelsQueryable(): NearestParcelsQueryable | null {
  if (injected !== undefined) return injected;
  return nearestParcelsQueryableFromEnv();
}
