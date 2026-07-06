/**
 * Drift guard for the tile capability registry served at
 * GET /api/plan-review/admin/tile-registry.
 *
 * The registry is the single source of truth in @empressaio/cortex-client that
 * BOTH the SPA (tiles.tsx) and this api-server route read. These assertions
 * lock the contract compose_workspace depends on: every entry carries the four
 * capability fields (requires / produces / modes / mcpTools), ids are unique,
 * and the full set is present (>= 46 entries).
 */

import { describe, it, expect } from "vitest";
import {
  TILE_CAPABILITIES,
  TILE_CAPABILITY_BY_ID,
} from "@empressaio/cortex-client";

describe("tile capability registry (admin/tile-registry contract)", () => {
  it("has at least the full 46-entry registry", () => {
    expect(TILE_CAPABILITIES.length).toBeGreaterThanOrEqual(46);
  });

  it("has unique tile ids", () => {
    const ids = TILE_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the four capability fields on every entry", () => {
    for (const cap of TILE_CAPABILITIES) {
      expect(typeof cap.id, `${cap.id} id`).toBe("string");
      expect(typeof cap.label, `${cap.id} label`).toBe("string");
      expect(typeof cap.category, `${cap.id} category`).toBe("string");
      expect(typeof cap.status, `${cap.id} status`).toBe("string");
      // requires / produces are objects (may be empty {}).
      expect(cap.requires, `${cap.id} requires`).toBeTypeOf("object");
      expect(cap.requires, `${cap.id} requires`).not.toBeNull();
      expect(cap.produces, `${cap.id} produces`).toBeTypeOf("object");
      expect(cap.produces, `${cap.id} produces`).not.toBeNull();
      // modes is a non-empty array of valid render modes.
      expect(Array.isArray(cap.modes), `${cap.id} modes array`).toBe(true);
      expect(cap.modes.length, `${cap.id} modes non-empty`).toBeGreaterThan(0);
      for (const m of cap.modes) {
        expect(["full", "card", "inline", "raw"]).toContain(m);
      }
      // mcpTools is always an array (empty [] is honest for planned tiles).
      expect(Array.isArray(cap.mcpTools), `${cap.id} mcpTools array`).toBe(true);
    }
  });

  it("uses only valid statuses and categories", () => {
    const statuses = ["live", "degraded", "partial", "planned"];
    const categories = [
      "Compliance",
      "Site Analysis",
      "Property Intel",
      "Design Accelerator",
      "Deliverable",
      "Market",
    ];
    for (const cap of TILE_CAPABILITIES) {
      expect(statuses, `${cap.id} status`).toContain(cap.status);
      expect(categories, `${cap.id} category`).toContain(cap.category);
    }
  });

  it("has a lookup entry for every capability", () => {
    for (const cap of TILE_CAPABILITIES) {
      expect(TILE_CAPABILITY_BY_ID[cap.id]).toBe(cap);
    }
  });

  it("includes the core live tiles compose_workspace expects", () => {
    const ids = new Set(TILE_CAPABILITIES.map((c) => c.id));
    for (const id of [
      "intake",
      "compliance-run",
      "document-viewer",
      "property-brief",
      "hazard",
      "map",
      "encumbrances",
      "response-tasks",
      "letter",
    ]) {
      expect(ids.has(id), `missing ${id}`).toBe(true);
    }
  });
});
