/**
 * Shared helpers for materializing Cortex L-surface (L1-L6) atom
 * instances from their backing Postgres rows.
 *
 * The L-surface endpoints (Lane C.4) return full atom instances
 * conforming to the `@workspace/atoms-l-surface` Zod schemas. Those
 * schemas extend `BaseAtomInstance`, which carries five provenance
 * fields the workflow-atom rows do not store as columns:
 *
 *   - `entityType`        — the atom's literal type tag.
 *   - `jurisdictionTenant`— single-tenant today; always
 *                           {@link DEFAULT_TENANT_ID}.
 *   - `fetchedAt`         — the atom's creation ISO timestamp.
 *   - `sourceAdapter`     — {@link L_SURFACE_SOURCE_ADAPTER}.
 *   - `sourceUrl`         — empty string (workflow atoms have no
 *                           external source URL).
 *   - `contentHash`       — sha256 hex of the canonical JSON of the
 *                           atom's domain fields.
 *
 * The canonical endpoint contract
 * (`doc_repo/_research/2026-05-19_l_surface_endpoint_contracts_cc-agent-M.md`)
 * describes the workflow-atom semantics but not these Base fields
 * explicitly — the contract prose is code-corpus-oriented. The
 * convention here was chosen for Lane C.4 and is surfaced to the
 * planner in the C.4.1 PR as a contract-prose gap; it is a one-line
 * change per surface if a different convention is wanted.
 */

import { createHash } from "node:crypto";

/**
 * `sourceAdapter` value for every L-surface atom. These atoms are
 * produced by legacy-design-tools itself (not scraped from an external
 * publisher), so the "adapter" is the runtime that minted them.
 */
export const L_SURFACE_SOURCE_ADAPTER = "legacy-design-tools";

/**
 * Recursively sort object keys so two callers serializing the same
 * logical value produce byte-identical JSON. Arrays keep their order
 * (order is semantically meaningful — e.g. letter sections); only
 * object keys are sorted.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic `contentHash` for an atom: sha256 hex of the canonical
 * JSON of its domain fields. Callers pass the atom's non-Base fields
 * (everything except `entityType` / `entityId` / `jurisdictionTenant` /
 * `fetchedAt` / `sourceAdapter` / `sourceUrl` / `contentHash`) so the
 * hash tracks the atom's actual content and changes when the row is
 * mutated.
 */
export function contentHashOf(domainFields: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(domainFields)), "utf8")
    .digest("hex");
}
