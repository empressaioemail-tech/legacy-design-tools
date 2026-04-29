/**
 * Per-file shared mutable context, populated by setup hooks and read by
 * `vi.mock` factories that proxy `db` from `@workspace/db` to the per-file
 * test schema's drizzle instance.
 *
 * Why a shared module instead of `vi.hoisted({...})`? Because the same state
 * needs to be read from BOTH the test file's mock factory AND from setup
 * helpers (`setupSchemaForFile`). Importing a tiny shared module is the
 * cleanest way to share that state across the two.
 */

import type { TestSchemaContext } from "@workspace/db/testing";

interface FileTestContext {
  schema: TestSchemaContext | null;
}

export const ctx: FileTestContext = {
  schema: null,
};
