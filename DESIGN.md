# Track B — Server-side IFC Ingest

**Status:** Recon complete. Awaiting Nick + Claude.ai approval before execute.
**Branch:** `track-b-ifc-ingest`
**Worktree:** `.claude/worktrees/track-b-ifc-ingest`

This document is recon-first. It captures what the codebase actually looks like, surfaces conflicts with the locked plan, and proposes resolutions. Section headings track the original sprint spec; recon-driven amendments are called out inline with **AMENDMENT** markers.

---

## 0. Executive summary of recon-driven amendments

Three locked decisions need refinement *before* execute, each because recon turned up a load-bearing fact the plan had not assumed.

1. **`element_kind` is not free for the provenance discriminator.** It already exists on `materializable_elements` and discriminates the seven Spec 51a §2.4 geometry kinds (`terrain`, `property-line`, `setback-plane`, `buildable-envelope`, `floodplain`, `wetland`, `neighbor-mass`). The C# Revit add-in dispatches on those values; mirrored in `converterClient.DXF_LAYER_KINDS`. We cannot overload it for `requirement` vs `as-built-from-ifc` without touching the add-in's enum and rewriting the briefing-engine emitters. **Proposal:** keep `element_kind` as the geometry discriminator, add a new column `source_kind text NOT NULL DEFAULT 'briefing-derived'` for the provenance/lens discriminator. Same one-table-many-lenses pattern Nick wants; just not the same column name.
2. **`briefing_id` is `NOT NULL` with cascade-delete to `parcel_briefings`.** IFC-derived rows do not have a briefing. **Proposal:** drop the `NOT NULL` and adjust read sites; cascade-delete stays for briefing-derived rows. (Alternative: synthesize a "as-built" briefing per snapshot. Rejected — pollutes briefing audit trail with non-briefing rows.)
3. **No `engagement_id` column on `materializable_elements`.** Relation walks `briefing_id → parcel_briefings.engagement_id`. The proposed `(engagement_id, element_kind)` index can't exist as written. **Proposal:** denormalize `engagement_id` onto `materializable_elements` (NOT NULL, FK to engagements, set on insert from either the briefing's engagement or the snapshot's engagement). Index `(engagement_id, source_kind)` for the viewer's filtered fetch.

These three together are the schema spine of the sprint. Everything else (storage, parser, endpoints) is independent of them.

A fourth recon finding shapes the parser strategy:

4. **Viewer loads exactly one GLB at a time, prioritizing the first element with a non-null `glbObjectPath`.** No multi-mesh assembly logic exists in `EngagementDetail.tsx`. Implication: the IFC parser must produce *one consolidated glTF* and write its path onto a single representative `materializable_elements` row, not per-IFC-entity GLBs. The per-entity rows still get inserted (for property/atom queries), but only one of them — or a synthetic "container" row — carries the GLB pointer. Cleanest: keep per-entity rows lean (no GLB), add a single new row of `element_kind = 'as-built-ifc-bundle'` carrying the consolidated `glbObjectPath`. Viewer prefers that row when present.

These four amendments are the Open Questions section's first four items. All implementation-shaping decisions descend from them.

---

## 1. Schema changes (RECON-AMENDED)

### 1.1 Existing `materializable_elements` schema (verbatim recon)

From `lib/db/src/schema/materializableElements.ts`:

| column | type | constraint | meaning |
|---|---|---|---|
| `id` | uuid | PK, defaultRandom | |
| `briefing_id` | uuid | **NOT NULL**, FK → parcel_briefings(id) **ON DELETE CASCADE** | the briefing that emitted this element |
| `element_kind` | text | NOT NULL | one of 7 closed values: `terrain`, `property-line`, `setback-plane`, `buildable-envelope`, `floodplain`, `wetland`, `neighbor-mass`. Mirrors `converterClient.DXF_LAYER_KINDS`. |
| `briefing_source_id` | uuid | nullable, FK → briefing_sources(id) ON DELETE SET NULL | cited source the geometry came from |
| `label` | text | nullable | UI-facing label |
| `geometry` | jsonb | NOT NULL DEFAULT `{}` | structured geometry payload, kind-discriminated |
| `glb_object_path` | text | nullable | object-storage path to converted glTF |
| `locked` | boolean | NOT NULL DEFAULT true | unpin-protection flag |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | |

Indexes:
- `materializable_elements_briefing_idx` on `briefing_id`
- `materializable_elements_kind_idx` on `(briefing_id, element_kind)`

Zero rows in production today (per the original recon). The schema is rich on geometry-typing, thin on provenance.

### 1.2 Proposed ALTERs (amended)

```sql
-- A. Provenance discriminator (rename-target of the locked plan's "elementKind").
--    Existing rows are all briefing-derived; default backfills cleanly.
ALTER TABLE materializable_elements
  ADD COLUMN source_kind text NOT NULL DEFAULT 'briefing-derived';

ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_source_kind_check
  CHECK (source_kind IN ('briefing-derived', 'as-built-ifc', 'as-built-ifc-bundle'));

-- B. Drop briefing_id NOT NULL so IFC rows can exist without a briefing.
--    Cascade-delete is preserved on the FK; rows with NULL briefing_id are not affected by briefing deletion.
ALTER TABLE materializable_elements
  ALTER COLUMN briefing_id DROP NOT NULL;

-- C. Denormalize engagement_id for the viewer's lens-filtered fetch and for
--    snapshot-driven inserts that don't have a briefing.
ALTER TABLE materializable_elements
  ADD COLUMN engagement_id uuid REFERENCES engagements(id) ON DELETE CASCADE;

-- Backfill from the existing briefing relation:
UPDATE materializable_elements me
SET engagement_id = pb.engagement_id
FROM parcel_briefings pb
WHERE me.briefing_id = pb.id AND me.engagement_id IS NULL;

ALTER TABLE materializable_elements
  ALTER COLUMN engagement_id SET NOT NULL;

-- D. IFC-only columns. NULL on briefing-derived rows.
ALTER TABLE materializable_elements
  ADD COLUMN ifc_global_id text,
  ADD COLUMN ifc_type text,
  ADD COLUMN property_set jsonb,
  ADD COLUMN source_snapshot_id uuid REFERENCES snapshots(id) ON DELETE CASCADE;

-- E. Conditional invariants: IFC rows must have ifc_global_id + ifc_type +
--    source_snapshot_id; briefing-derived rows must have briefing_id.
ALTER TABLE materializable_elements
  ADD CONSTRAINT materializable_elements_provenance_invariants_check
  CHECK (
    (source_kind = 'briefing-derived' AND briefing_id IS NOT NULL)
    OR (source_kind IN ('as-built-ifc', 'as-built-ifc-bundle')
        AND source_snapshot_id IS NOT NULL
        AND ifc_global_id IS NOT NULL
        AND ifc_type IS NOT NULL)
  );

-- F. Indexes.
CREATE INDEX materializable_elements_engagement_source_idx
  ON materializable_elements (engagement_id, source_kind);

CREATE INDEX materializable_elements_snapshot_idx
  ON materializable_elements (source_snapshot_id)
  WHERE source_snapshot_id IS NOT NULL;

-- G. Drop the redundant geometry_blob_ref idea. glb_object_path already does this job.
--    No change needed.
```

**Drift from locked plan:** the locked plan listed `geometry_blob_ref` as a new column. Schema already has `glb_object_path` for exactly this purpose; reuse it. Per-IFC-entity rows leave it null; the bundle row carries it.

### 1.3 New table: `snapshot_ifc_files`

```sql
CREATE TABLE snapshot_ifc_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id uuid NOT NULL UNIQUE REFERENCES snapshots(id) ON DELETE CASCADE,
  blob_object_path text NOT NULL,           -- "/objects/<uuid>" via ObjectStorageService
  gltf_object_path text,                    -- consolidated glTF cache; null until parse done
  file_size_bytes bigint NOT NULL,
  ifc_version text,                         -- e.g. "IFC4", "IFC2X3" (parsed from header)
  export_duration_ms integer,               -- reported by add-in
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  parsed_at timestamptz,                    -- null until web-ifc finishes; non-null on success
  parse_error text,                         -- null on success; populated on failure
  parse_entity_count integer,               -- count of materialized entities (debug/observability)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX snapshot_ifc_files_parsed_at_idx ON snapshot_ifc_files (parsed_at);
```

Idempotency via `UNIQUE (snapshot_id)`: re-uploading from the same snapshot upserts the row, replaces blobs, and re-parses (delete-then-insert the per-entity `materializable_elements` rows). See §3 for the upsert flow.

### 1.4 Migration strategy (no-migration-journal constraint)

The repo deliberately doesn't ship drizzle migration files; schema changes are applied to dev (helium) via `drizzle-kit push` and to deployment Neon by hand-applied SQL. The exact two-step:

**Dev (helium):**
1. Edit `lib/db/src/schema/materializableElements.ts` and add `lib/db/src/schema/snapshotIfcFiles.ts`.
2. Re-export from `lib/db/src/schema/index.ts`.
3. `pnpm --filter @workspace/db run db:push` (whatever the existing alias is — verify in `lib/db/package.json` during execute).

**Deployment (Neon):**
- Hand-apply the SQL in §1.2 + §1.3 verbatim, in a single transaction.
- Confirm zero rows existed beforehand (`SELECT count(*) FROM materializable_elements;`) so the backfill UPDATE is a no-op.

This DESIGN.md will carry the final SQL block as a copy-pasteable transaction at execute time. Recon does not run any DDL.

---

## 2. New table: `snapshot_ifc_files` (covered above in §1.3)

Mirrors the locked plan's intent. Naming convention follows the repo's `snake_case` table convention.

Relation diagram (recon-confirmed):

```
engagements
  └── snapshots (engagement_id FK)
        ├── sheets (snapshot_id FK, bytea-stored PNGs)
        └── snapshot_ifc_files (snapshot_id FK, GCS-stored .ifc + .glb)
              └── materializable_elements (source_snapshot_id FK, source_kind = 'as-built-ifc' | 'as-built-ifc-bundle')
```

---

## 3. New endpoint: `POST /api/snapshots/:id/ifc`

### 3.1 Wire shape

Multipart/form-data, mirroring the existing sheet upload at `POST /api/snapshots/:snapshotId/sheets`. Same Busboy-based parser pattern (see `routes/sheets.ts:208-326`). Two parts:

| name | content | required |
|---|---|---|
| `metadata` | JSON: `{ ifcVersion?: string, fileSizeBytes: number, exportDurationMs?: number }` | yes |
| `ifc` | the `.ifc` file bytes, content-type `application/octet-stream` or `application/x-step` | yes |

Auth: `x-snapshot-secret` header, validated via the existing `getSnapshotSecret()` cached singleton in `lib/snapshotSecret.ts`. 401 on mismatch. Same pattern as sheet upload.

Limits (proposal — confirm with Nick):
- 200 MB per IFC file (sheets cap at 150 MB total; IFC needs more headroom for federated models).
- 1 IFC file per request.
- Reject if the snapshot's engagement is not the caller's tenant — but recon shows the snapshot-secret middleware is *global*, not per-tenant; auth is single-secret. Out of scope for this sprint.

### 3.2 Behavior

```
1. Verify x-snapshot-secret. 401 on mismatch.
2. Look up snapshots.id. 404 if missing (add-in handles gracefully).
3. Parse multipart. Reject non-multipart with 415; reject missing parts with 400.
4. Persist IFC blob via ObjectStorageService.uploadObjectEntityFromBuffer(bytes, "application/octet-stream").
   → returns "/objects/<uuid>"; this is blob_object_path.
5. Upsert snapshot_ifc_files by snapshot_id:
   - If row exists, delete materializable_elements WHERE source_snapshot_id = $1 (replaces atoms).
   - If row exists, schedule deletion of the OLD blob_object_path + gltf_object_path
     (best-effort via deleteObjectIfStored) AFTER the new row is committed.
   - Insert/update with blob_object_path set, parsed_at = NULL, parse_error = NULL.
6. Hand the ifc-files row to the parser worker (see §7). This is the synchronous boundary
   when running inline; the async boundary when running in a worker.
7. Parser:
   a. Initialize web-ifc singleton (cached after first call; ~sub-second cold start).
   b. OpenModel(bytes).
   c. For each tracked entity type (IFCWALL, IFCSLAB, IFCDOOR, IFCWINDOW, IFCSPACE,
      IFCCOLUMN, IFCBEAM, IFCROOF, IFCBUILDINGELEMENTPROXY):
      - GetLineIDsWithType + per-line GetLine(flatten=true).
      - Extract Pset_*Common attributes via FlattenLine recursion.
      - Insert one materializable_elements row with:
          source_kind = 'as-built-ifc'
          source_snapshot_id = $snapshot_id
          engagement_id = (lookup from snapshots.engagement_id)
          element_kind = (mapped from IFC type — see §3.3 mapping table; NULL or
                          'as-built-ifc' if no spec mapping; route layer must accept this)
          ifc_global_id = the GUID
          ifc_type = "IfcWall" / etc.
          label = parsed Name attribute or fallback
          geometry = {} (real geometry lives in the consolidated glTF)
          property_set = the flattened Pset jsonb
          briefing_id = NULL
          locked = false (architect can edit; add-in syncs back later)
   d. StreamAllMeshes(modelID, ...). Build a single glTF doc via @gltf-transform/core,
      one node per FlatMesh placement, vertex/index buffers from web-ifc's WASM heap.
   e. Encode glb. Persist via uploadObjectEntityFromBuffer(glb, "model/gltf-binary").
   f. Insert one container materializable_elements row:
        source_kind = 'as-built-ifc-bundle'
        element_kind = 'as-built-ifc'   -- new closed-tuple value, see §3.3
        glb_object_path = the consolidated path
        engagement_id = (snapshot's engagement)
        source_snapshot_id = $snapshot_id
        briefing_id = NULL
        ifc_global_id = "<bundle:" + snapshot_id + ">" -- synthetic, satisfies CHECK
        ifc_type = "<bundle>"           -- synthetic
   g. Update snapshot_ifc_files.parsed_at = now(), gltf_object_path = bundle path,
      parse_entity_count = N, ifc_version = parsed-from-header.
   h. CloseModel(modelID). Release WASM memory.
   i. Emit ifc.ingested event onto the engagement timeline (see existing
      engagementEvents.ts patterns).
8. On parser error: snapshot_ifc_files.parse_error = err.message; parsed_at stays NULL;
   per-entity rows are NOT inserted (transactional with the parse step). Return 422.
   The blob is preserved for debugging.
9. On storage error before any DB write: 500, no DB writes.
```

### 3.3 IFC-type → `element_kind` mapping

This is the mapping that lets IFC entities reuse the existing `element_kind` column without overloading its meaning. Most IFC entities don't fit any of the 7 spec geometry kinds; for those, we add a single new value `as-built-ifc`:

| IFC type | `element_kind` | rationale |
|---|---|---|
| `IfcSite` (footprint) | `terrain` | matches existing geometry-kind semantics |
| `IfcSpace` (boundary polygon) | (none) → `as-built-ifc` | no clean spec mapping |
| `IfcWall`, `IfcSlab`, `IfcDoor`, `IfcWindow`, `IfcColumn`, `IfcBeam`, `IfcRoof`, `IfcBuildingElementProxy` | `as-built-ifc` | new closed-tuple value |

Schema implication: extend `MATERIALIZABLE_ELEMENT_KINDS` from 7 → 8 values:

```typescript
export const MATERIALIZABLE_ELEMENT_KINDS = [
  "terrain",
  "property-line",
  "setback-plane",
  "buildable-envelope",
  "floodplain",
  "wetland",
  "neighbor-mass",
  "as-built-ifc",          // NEW
] as const;
```

The C# add-in's `DXF_LAYER_KINDS` mirror does *not* need this 8th value — IFC rows are filtered out at the C#-facing read (see §6). Server-side validators that hardcode the 7-tuple need updating; recon found these are the briefing-engine emitter and route validators. Two known sites; both small edits.

### 3.4 Error matrix

| condition | status | body | side effects |
|---|---|---|---|
| missing/invalid `x-snapshot-secret` | 401 | `{error: "unauthorized"}` | none |
| `:id` doesn't match a snapshot | 404 | `{error: "snapshot_not_found"}` | none (add-in handles gracefully) |
| not multipart | 415 | `{error: "expected_multipart"}` | none |
| missing `ifc` part | 400 | `{error: "missing_ifc_part"}` | none |
| missing `metadata` part | 400 | `{error: "missing_metadata_part"}` | none |
| metadata JSON malformed | 400 | `{error: "invalid_metadata"}` | none |
| file > size cap | 413 | `{error: "file_too_large"}` | none |
| storage upload fails | 500 | `{error: "storage_error"}` | no DB writes |
| web-ifc parse fails | 422 | `{error: "ifc_parse_failed", detail: <message>}` | snapshot_ifc_files row persists with parse_error; blob preserved; no atom rows |
| success | 201 | `{ ifcFileId, parsedAt, entityCount, gltfObjectPath }` | atoms inserted; ifc.ingested event emitted |

---

## 4. New endpoint: `GET /api/snapshots/:id/ifc`

Returns the raw IFC blob.

```
1. Look up snapshot_ifc_files WHERE snapshot_id = $1. 404 if missing.
2. Stream blob_object_path via ObjectStorageService.getObjectEntityFile(...).createReadStream().
3. Headers: Content-Type: application/octet-stream, Content-Length, Cache-Control: private, max-age=300.
4. Auth: requiresArchitectAudience() — same gate as briefing-source GLB serving.
   (The add-in does NOT need to fetch this back; it pushed it. Viewer/admin tools fetch it.)
```

---

## 5. New endpoint: `GET /api/snapshots/:id/ifc/gltf`

Returns the consolidated glTF binary.

```
1. Look up snapshot_ifc_files WHERE snapshot_id = $1.
2. 404 if row missing OR parsed_at IS NULL OR parse_error IS NOT NULL.
3. Stream gltf_object_path via getObjectEntityFile(...).createReadStream().
4. Headers: Content-Type: model/gltf-binary, ETag (weak, derived from gltf_object_path
   uuid), Cache-Control: private, max-age=3600.
5. Auth: requiresArchitectAudience().
```

The viewer's existing GLB-load path keys off `materializable_elements.glb_object_path`; this endpoint is a more-direct alternative for the viewer when it knows the snapshot id. Both work; the viewer can use whichever is convenient.

---

## 6. `bim_models` lifecycle strategy (RECON-AMENDED)

### 6.1 Recon-confirmed read path

`GET /api/engagements/:id/bim-model` (`routes/bimModels.ts:909-947`) does NOT do a 3-table SQL join. Two sequential queries:

1. `SELECT * FROM bim_models WHERE engagement_id = ?` → `bm`.
2. If `bm.activeBriefingId` is set: `SELECT * FROM materializable_elements WHERE briefing_id = ?` → `elements`.
3. Returns `{ bimModel: { ...bm, elements } }` or `{ bimModel: null }`.

Frontend (`EngagementDetail.tsx:4565-4590`) consumes `bimModel.elements` and renders the *first one* with a non-null `glb_object_path`. **One mesh at a time.** No multi-element assembly.

### 6.2 Updated proposal: hybrid Option β with viewer-side preference

**Option α** (snapshot creates synthetic bim_models row pointing at a synthetic briefing) is rejected — pollutes the parcel_briefings table with non-briefing rows and the briefing audit trail.

**Option β** (viewer fallback to materializable_elements directly) is the right shape, but the recon-amended schema lets us make it cleaner than the locked plan suggested. Concretely:

Update `loadElementsForBimModel(bm, engagementId)` (helper in `routes/bimModels.ts`) to:

```
1. Determine the most-recent IFC ingest for this engagement:
     SELECT sif.* FROM snapshot_ifc_files sif
     JOIN snapshots s ON s.id = sif.snapshot_id
     WHERE s.engagement_id = $1 AND sif.parsed_at IS NOT NULL
     ORDER BY sif.parsed_at DESC LIMIT 1.
2. If no IFC and no bm.activeBriefingId: return [].
3. If only briefing: load briefing-derived elements as before.
4. If only IFC: load WHERE engagement_id = $1 AND source_kind IN
     ('as-built-ifc', 'as-built-ifc-bundle') AND source_snapshot_id = $latest.
5. If both: prefer IFC bundle row for GLB rendering; include briefing-derived rows
   for the timeline/findings cross-reference.
```

The viewer then gets the same wire shape as today; it sees the `as-built-ifc-bundle` row first (because we order it first in the result) and renders its glTF. No frontend changes required for the basic case.

### 6.3 Engagement-id filtering: backward compatibility for the C# add-in

The C# add-in's `bim-model` endpoint MUST keep returning only briefing-derived elements until the add-in is updated. Add a route-level filter:

```typescript
// routes/bimModels.ts, in loadElementsForBriefing or a new sibling
const elements = await db.select()
  .from(materializableElements)
  .where(and(
    eq(materializableElements.briefingId, briefingId),
    eq(materializableElements.sourceKind, 'briefing-derived'),  // NEW
  ))
  .orderBy(materializableElements.elementKind, materializableElements.createdAt);
```

This is a one-line change in `routes/bimModels.ts:loadElementsForBriefing` and prevents the add-in from receiving IFC rows it can't materialize.

The viewer-facing engagement endpoint gets the union (see §6.2). The add-in-facing briefing endpoint stays briefing-derived-only.

### 6.4 No `bim_models` row on snapshot push — confirmed

Recon confirms no auto-creation. Snapshot push handles only sheet ingest; the C# add-in creates `bim_models` rows separately via `POST /api/engagements/:id/bim-model`. We DON'T change that. The IFC ingest path simply populates `materializable_elements` rows reachable via the `engagement_id` denormalization, and the viewer fallback in §6.2 surfaces them whether or not a `bim_models` row exists.

---

## 7. web-ifc integration (RECON-DETAILED)

### 7.1 Install

```
pnpm --filter @workspace/api-server add web-ifc @gltf-transform/core
```

`web-ifc` ships three WASM artifacts (`web-ifc.wasm`, `web-ifc-mt.wasm`, `web-ifc-node.wasm`). Node entry is `web-ifc/web-ifc-api-node.js` (CJS). The package's `exports` map only resolves the Node entry under the `require` condition — pure ESM `import` resolves to the *browser* entry, which breaks. Two safe patterns:

```typescript
// (A) Reach for the Node entry explicitly
import * as WebIFC from "web-ifc/web-ifc-api-node.js";

// (B) createRequire (the api-server's esbuild banner already injects globalThis.require)
const WebIFC = require("web-ifc");  // resolves Node entry via "require" condition
```

Recommend (A) — explicit, no reliance on the banner's require shim continuing to exist.

### 7.2 esbuild config

`artifacts/api-server/build.mjs` line 30 has the `external` allowlist. Add:

```js
external: [
  ...existing,
  "web-ifc",
  "web-ifc/web-ifc-api-node.js",
],
```

Why external: `web-ifc-api-node.js` does `fs.readFileSync(path.join(__dirname, "web-ifc-node.wasm"))` to load WASM bytes. If bundled, `__dirname` resolves to `dist/`, where the wasm doesn't exist. Externalizing keeps the require resolving against `node_modules/web-ifc/`, where the wasm lives next to the JS. The Replit deploy already ships `node_modules/`, matching how `puppeteer` and `@google-cloud/storage` are handled. **No copy step needed.**

### 7.3 Singleton init

Per-process singleton, lazy-initialized:

```typescript
// artifacts/api-server/src/lib/ifcParser/wasmRuntime.ts
import * as WebIFC from "web-ifc/web-ifc-api-node.js";

let cached: Promise<WebIFC.IfcAPI> | null = null;

export function getIfcApi(): Promise<WebIFC.IfcAPI> {
  if (!cached) {
    cached = (async () => {
      const api = new WebIFC.IfcAPI();
      // Optional but defensive — explicit wasm path so Init() doesn't construct
      // a relative URL that breaks under bundlers / odd cwd.
      api.SetWasmPath(
        path.join(require.resolve("web-ifc/package.json"), "..") + path.sep,
        true,
      );
      await api.Init();
      return api;
    })();
  }
  return cached;
}
```

Init cost: sub-second cold; zero on warm reuse. Memory: ~30-50 MB resident for the WASM module itself; per-parse adds 100-500 MB peak for a 10-50 MB IFC. `CloseModel(modelID)` after each parse releases native heap.

### 7.4 Worker-thread isolation (mandatory)

The api-server is a long-lived Express process. A misbehaving IFC parse that OOMs will kill the entire server. **Run parses in `worker_threads`**, one parse per worker, kill the worker on completion. This cleanly isolates memory and side-steps the WASM-singleton-non-reentrancy problem (the single shared `IfcAPI` cannot service two concurrent parses).

Pattern:

```
artifacts/api-server/src/lib/ifcParser/
├── index.ts           // public API: parseIfcFromObjectPath(path): Promise<ParseResult>
├── wasmRuntime.ts     // singleton getter, only loaded inside the worker
├── worker.ts          // worker entry; receives blob bytes, returns ParseResult
└── gltfEmitter.ts     // FlatMesh stream → @gltf-transform/core glb
```

`index.ts` spawns a `Worker(new URL("./worker.js", import.meta.url))`, posts `{ blobObjectPath }`, awaits a single `message` carrying `ParseResult` or an `error` event. Bound the worker with a 5-minute timeout.

### 7.5 Parse pipeline pseudocode

```typescript
// worker.ts
import { parentPort } from "node:worker_threads";
import * as WebIFC from "web-ifc/web-ifc-api-node.js";
import { Document, NodeIO } from "@gltf-transform/core";
import { getObjectEntityBytes, uploadObjectEntityFromBuffer } from "../objectStorage";

parentPort!.on("message", async ({ blobObjectPath, snapshotId }) => {
  try {
    const bytes = await getObjectEntityBytes(blobObjectPath);
    const api = await getIfcApi();
    const modelID = api.OpenModel(bytes);

    const ifcVersion = api.GetIfcSchemaVersion(modelID);
    const tracked = [
      WebIFC.IFCWALL, WebIFC.IFCSLAB, WebIFC.IFCDOOR, WebIFC.IFCWINDOW,
      WebIFC.IFCSPACE, WebIFC.IFCCOLUMN, WebIFC.IFCBEAM, WebIFC.IFCROOF,
      WebIFC.IFCBUILDINGELEMENTPROXY,
    ];

    const entities: EntityRow[] = [];
    for (const typeId of tracked) {
      const ids = api.GetLineIDsWithType(modelID, typeId);
      for (let i = 0; i < ids.size(); i++) {
        const expressID = ids.get(i);
        const line = api.GetLine(modelID, expressID, /*flatten=*/ true);
        entities.push({
          ifcGlobalId: line.GlobalId?.value ?? `<no-guid:${expressID}>`,
          ifcType: typeName(typeId),
          label: line.Name?.value ?? null,
          propertySet: extractPsetCommon(line),
        });
      }
    }

    const doc = new Document();
    // ...build glTF from streamed FlatMeshes...
    api.StreamAllMeshes(modelID, (mesh) => emitMeshIntoDoc(doc, mesh, api, modelID));
    const glb = await new NodeIO().writeBinary(doc);

    api.CloseModel(modelID);

    const gltfObjectPath = await uploadObjectEntityFromBuffer(
      Buffer.from(glb), "model/gltf-binary",
    );

    parentPort!.postMessage({
      ok: true,
      ifcVersion,
      entities,
      gltfObjectPath,
    });
  } catch (err: any) {
    parentPort!.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
});
```

Caller (the route handler) gets back the structured result and writes the DB rows in a single transaction.

### 7.6 Open performance question

I have no first-party measurement of init cost or per-parse throughput on this codebase's hosting. Recon estimates (sub-second init, hundreds of ms to seconds per 10-50 MB parse) come from third-party reports. **Execute step 0:** drop a representative Revit-exported IFC into a `.skip`-tagged vitest, measure init + parse + glTF emit on Replit's runtime, set the inline-vs-background threshold from data. If a typical parse is < 5 s wall clock, prefer inline (synchronous in the worker, but the route awaits the worker's message before responding 201). If 5-30 s, return 202 Accepted with a `parsedAt = null` row and let the worker continue; viewer polls. If > 30 s, this is a queue-backed job, not a request-bound parse. **Recommend** starting inline + worker; revisit if measurements show otherwise.

---

## 8. Risks + Open Questions

### 8.1 Open questions blocking execute (need Nick's call)

1. **`source_kind` column name.** OK to use `source_kind`? Alternatives: `provenance`, `lens`, `origin_kind`. Prefer `source_kind` for symmetry with `source_snapshot_id`.
2. **`briefing_id` nullability.** OK to drop NOT NULL? The CHECK invariant in §1.2 enforces that briefing-derived rows still have it; only IFC rows can be null.
3. **`engagement_id` denormalization.** OK to add it, or do you want the viewer to walk briefing relations even for IFC rows? (Strongly prefer the denormalization — IFC rows have no briefing.)
4. **8th `MATERIALIZABLE_ELEMENT_KINDS` value.** OK to add `as-built-ifc`? The C# add-in's `DXF_LAYER_KINDS` does *not* need to mirror it (filter at the briefing endpoint). But anyone validating server-side against the closed tuple needs the new value.
5. **One bundle row vs N entity rows + N GLBs.** Plan recommends one consolidated glTF carried by a synthetic `as-built-ifc-bundle` row, plus N lean per-entity rows for property/atom queries. The viewer's "first row with glb_object_path wins" pattern makes this trivially correct. OK?
6. **Storage retention.** No retention policy proposed. 5-50 MB IFC × N snapshots × T tenants — could grow. Recommend a separate sprint for object-storage GC; out of scope here.
7. **Re-upload semantics.** Same snapshot re-pushes IFC → upsert by `snapshot_id`, replace blobs, re-parse, replace atoms. OK? (This is the behavior planned; just confirming.)

### 8.2 Risks to accept

- **web-ifc parse failures on edge-case Revit IFCs.** Surface in `parse_error`; preserve blob; manual triage. No IfcOpenShell fallback (would require Python in the stack — explicitly out of scope per locked decisions).
- **Memory ceiling on large IFCs.** Worker-thread isolation prevents server kill; the parse fails with a process-exit, surfaced as `parse_error`. A 200 MB cap on upload size is the first defense; revisit if real Revit exports exceed it.
- **Concurrency.** WASM singleton is non-reentrant; serial parses inside one worker, but a worker pool can run in parallel. Start with a pool size of 2; tune if measurements warrant.
- **glTF emitter complexity.** `@gltf-transform/core` plus the `web-ifc` `FlatMesh` → glTF translation is the most novel code in this sprint. ~150 LOC, but with degeneracy/CCW edge cases worth testing against multiple Revit exports. Plan a small fixture corpus.
- **Coordinate origin drift.** Revit projects far from origin emit IFC with huge offsets. Out of scope to rebase here, but flag for the viewer team if geometry appears "miles away".
- **Phasing & MVD differences.** Revit's MVD ("Reference View" vs "Design Transfer View") changes geometry. Document the expected MVD with the add-in team.

### 8.3 Risks to discount

- **Backward compatibility on existing rows.** Production has zero `materializable_elements` rows today. Backfill is trivially correct.
- **Read-site assumptions across findings.ts/renders.ts/atom adapter.** All read sites are permissive — they don't filter on `element_kind` or hardcode the closed tuple at read time. Adding new values flows through cleanly. Only the briefing-engine emitter and the add-in-facing `bim-model` endpoint validate against the tuple, and those are the two sites we touch.

---

## 9. Sprint deliverable list (post-approval execute)

Split by stream so streams can run in parallel where possible.

### BE schema (1 day, blocking-everything)
- Edit `lib/db/src/schema/materializableElements.ts`: add `sourceKind`, `engagementId`, `ifcGlobalId`, `ifcType`, `propertySet`, `sourceSnapshotId`. Update `MATERIALIZABLE_ELEMENT_KINDS` to 8 values. Drop `briefingId.notNull()`. Add new indexes. Add CHECK constraint via raw SQL in a `__sql__` block (drizzle convention; verify in execute).
- Add `lib/db/src/schema/snapshotIfcFiles.ts`. Re-export from `lib/db/src/schema/index.ts`.
- Apply via `drizzle-kit push` to dev (helium). Hand-apply the §1.2-§1.3 SQL transaction to deploy (Neon).
- Update `lib/db/src/__tests__` schema-shape tests if any reference materializable_elements column counts.

### BE endpoints (2 days, depends on schema)
- `routes/snapshots.ts`: add `POST /:id/ifc`, `GET /:id/ifc`, `GET /:id/ifc/gltf`. Wire to a new `lib/ifcUpload.ts` helper module that owns the multipart parsing (Busboy reuse from sheets.ts pattern), worker dispatch, transactional DB writes.
- `routes/bimModels.ts`: in `loadElementsForBriefing`, add `eq(materializableElements.sourceKind, 'briefing-derived')` clause. Add the engagement-level fallback (§6.2) as a new helper `loadElementsForEngagement(engagementId)` that the engagement bim-model endpoint calls.
- Emit `ifc.ingested` engagement event via existing `engagementEvents.ts` patterns.

### Parser module (2-3 days, depends on schema; parallelizable with endpoints)
- `artifacts/api-server/src/lib/ifcParser/{index.ts, wasmRuntime.ts, worker.ts, gltfEmitter.ts}`.
- Add `web-ifc` and `@gltf-transform/core` to `artifacts/api-server/package.json`.
- Update `artifacts/api-server/build.mjs` external allowlist.
- Worker spawn + timeout + error-pipe scaffolding.
- IFC entity extraction, Pset_*Common flattening, FlatMesh → glTF emit.
- A measurement pass on a real Revit-exported IFC to set the inline-vs-background threshold.

### Read-site updates + atom doc (0.5 day, depends on schema)
- Update the briefing-engine emitter and any other site that hardcodes `MATERIALIZABLE_ELEMENT_KINDS.length === 7`.
- Update `materializable-element.atom.ts:contextSummary()` if it surfaces `sourceKind` in prose (recommend yes — distinguishes "as-built from Revit IFC export" from "design requirement").
- Update the atom catalog doc (likely `02_architecture_reference.md` or wherever — confirm in execute).

### Tests (1 day, end of sprint)
- Schema migration smoke test: insert a briefing-derived row + an IFC row + a bundle row; verify CHECK constraint rejects malformed combos.
- Endpoint integration tests:
  - 401 on bad secret.
  - 404 on unknown snapshot.
  - 422 on a deliberately malformed IFC fixture.
  - Happy path: valid small IFC → 201, atoms inserted, glb fetchable.
  - Re-upload: second POST replaces atoms, deletes old blobs.
- Parser unit test: a 5-entity hand-crafted IFC → exactly 5 atom rows + 1 bundle row, glb is non-empty, `parsed_at` set.
- Worker-thread isolation test: simulate an OOM in the worker (large heap allocation) and verify the parent process survives with a `parse_error` populated.

### Effort total
- BE schema: 1 day
- BE endpoints: 2 days
- Parser: 2-3 days
- Read-site/atom doc: 0.5 day
- Tests: 1 day
- **Total: 6.5-7.5 days**, with 1-1.5 days of float for measurement-driven tuning (inline vs queue threshold) and Revit-IFC fixture hunting.

---

## Appendix A: file-level recon citations

| concern | file | line(s) |
|---|---|---|
| materializable_elements schema | `lib/db/src/schema/materializableElements.ts` | 23-126 |
| snapshots schema | `lib/db/src/schema/snapshots.ts` | 13-34 |
| bim_models schema | `lib/db/src/schema/bimModels.ts` | 41-95 |
| snapshot ingest route | `artifacts/api-server/src/routes/snapshots.ts` | 527-735 |
| sheet upload (multipart pattern) | `artifacts/api-server/src/routes/sheets.ts` | 208-326 |
| object storage abstraction | `artifacts/api-server/src/lib/objectStorage.ts` | 122-516 |
| snapshot secret auth | `artifacts/api-server/src/lib/snapshotSecret.ts` | 6-24 |
| bim-model viewer read | `artifacts/api-server/src/routes/bimModels.ts` | 909-947, 490-498, 500-517 |
| bim-model GLB stream | `artifacts/api-server/src/routes/bimModels.ts` | 839-907 |
| bim-model element loader | `artifacts/api-server/src/routes/bimModels.ts` | 493-497 |
| frontend GLB consumption | `artifacts/design-tools/.../EngagementDetail.tsx` | 4565-4590 |
| materializable-element atom | `artifacts/api-server/src/atoms/materializable-element.atom.ts` | 147-236 |
| bim-model atom | `artifacts/api-server/src/atoms/bim-model.atom.ts` | 217-367 |
| converterClient closed tuple | `artifacts/api-server/src/lib/converterClient.ts` | 18-26 |
| esbuild api-server build | `artifacts/api-server/build.mjs` | 30 (external array) |

## Appendix B: web-ifc reference URLs

- Package: https://www.npmjs.com/package/web-ifc
- Source: https://github.com/ThatOpen/engine_web-ifc
- API docs: https://github.com/ThatOpen/engine_web-ifc/blob/main/src/ts/web-ifc-api.ts
- Node init issue: https://github.com/IFCjs/web-ifc/issues/268
- esbuild + WASM: https://github.com/evanw/esbuild/issues/3904
- Memory profiling reference: https://altersquare.medium.com/handling-large-ifc-files-in-web-applications-performance-optimization-guide-66de9e63506f

---

**END OF DESIGN.md — awaiting Nick + Claude.ai approval to begin execute.**
