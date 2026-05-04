/**
 * Convert web-ifc's `LoadAllGeometry` / `StreamAllMeshes` output into a
 * single .glb buffer. The viewer (EngagementDetail.tsx) renders one GLB
 * per `materializable_elements` row; we attach the consolidated GLB to a
 * synthetic `as-built-ifc-bundle` row so the existing one-mesh-at-a-time
 * read path works without changes.
 *
 * Geometry assembly:
 *   - One glTF Node per FlatMesh placement, transform encoded directly.
 *   - One glTF Mesh per geometry id (shared across instances when present).
 *   - Single buffer, single view per attribute kind, interleaved-positions.
 *   - Vertex colors copied from FlatMesh per-placement color (RGBA).
 *
 * No materials / PBR — viewer renders mesh-color via vertex attributes.
 * Keep the GLB lean; an architect's IFC can have tens of thousands of
 * meshes and per-mesh material bloats both wire size and parse time.
 */

import type { IfcAPI } from "web-ifc";
import { Document, NodeIO, type Mesh, type Node } from "@gltf-transform/core";

interface FlatMesh {
  expressID: number;
  geometries: { size(): number; get(i: number): PlacedGeometry };
}

interface PlacedGeometry {
  color: { x: number; y: number; z: number; w: number };
  geometryExpressID: number;
  flatTransformation: number[]; // 4x4 column-major
}

/**
 * Stream all geometry from the open model into a glTF Document and encode
 * the document as a .glb. Caller is responsible for OpenModel/CloseModel
 * lifecycle.
 *
 * Returns an empty .glb (one empty scene) when the model has no geometry —
 * better than throwing, because the route layer still wants to record the
 * parse as successful and emit the per-entity rows.
 */
export async function modelToGlb(
  api: IfcAPI,
  modelID: number,
): Promise<Buffer> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();

  // Cache geometry-id → glTF Mesh so instanced placements share buffers.
  const meshCache = new Map<number, Mesh>();

  api.StreamAllMeshes(modelID, (flatMesh: FlatMesh) => {
    const placements = flatMesh.geometries;
    for (let i = 0; i < placements.size(); i++) {
      const placement = placements.get(i);
      const geomId = placement.geometryExpressID;
      let mesh = meshCache.get(geomId);
      if (!mesh) {
        mesh = buildMeshForGeometry(api, modelID, geomId, doc, buffer);
        if (!mesh) continue;
        meshCache.set(geomId, mesh);
      }
      const node = doc
        .createNode(`mesh_${flatMesh.expressID}_${i}`)
        .setMesh(mesh)
        .setMatrix(placement.flatTransformation as unknown as Parameters<Node["setMatrix"]>[0]);
      scene.addChild(node);
    }
  });

  const glb = await new NodeIO().writeBinary(doc);
  return Buffer.from(glb);
}

function buildMeshForGeometry(
  api: IfcAPI,
  modelID: number,
  geometryExpressID: number,
  doc: Document,
  buffer: ReturnType<Document["createBuffer"]>,
): Mesh | null {
  // GetGeometry returns vertex/index buffer pointers into the WASM heap.
  // We copy out before any subsequent web-ifc call invalidates them.
  const geom = api.GetGeometry(modelID, geometryExpressID);
  const vertSrc = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
  const idxSrc = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
  if (!vertSrc.length || !idxSrc.length) return null;

  // web-ifc's vertex format is interleaved [px py pz nx ny nz] per vertex.
  const vertCount = vertSrc.length / 6;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) {
    positions[i * 3] = vertSrc[i * 6];
    positions[i * 3 + 1] = vertSrc[i * 6 + 1];
    positions[i * 3 + 2] = vertSrc[i * 6 + 2];
    normals[i * 3] = vertSrc[i * 6 + 3];
    normals[i * 3 + 1] = vertSrc[i * 6 + 4];
    normals[i * 3 + 2] = vertSrc[i * 6 + 5];
  }
  const indices = new Uint32Array(idxSrc);

  const positionAcc = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType("VEC3")
    .setArray(positions);
  const normalAcc = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType("VEC3")
    .setArray(normals);
  const indexAcc = doc
    .createAccessor()
    .setBuffer(buffer)
    .setType("SCALAR")
    .setArray(indices);

  const primitive = doc
    .createPrimitive()
    .setAttribute("POSITION", positionAcc)
    .setAttribute("NORMAL", normalAcc)
    .setIndices(indexAcc);

  return doc.createMesh(`geom_${geometryExpressID}`).addPrimitive(primitive);
}
