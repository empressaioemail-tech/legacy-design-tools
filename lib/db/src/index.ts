import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

export * from "./schema";
export {
  withClusterSweepLock,
  type ClusterLockDbHandle,
  type ClusterLockTxHandle,
  type WithClusterSweepLockResult,
} from "./clusterLock";
export {
  swapStagedCounty,
  SourceFeatureSwapEmptyStageError,
  SourceFeatureSwapCountMismatchError,
  SOURCE_FEATURE_SWAP_EMPTY_STAGE,
  SOURCE_FEATURE_SWAP_COUNT_MISMATCH,
  type SourceFeatureSwapDbHandle,
  type SwapStagedCountyParams,
  type SwapStagedCountyResult,
} from "./sourceFeatureSwap";
