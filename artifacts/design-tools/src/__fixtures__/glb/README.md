# `__fixtures__/glb` — Three.js viewer test fixtures

Synthetic glb files driving `SiteContextViewer.test.tsx` and any other
DA-MV-1 viewer test. Each file is a hand-built binary glTF 2.0 (no
DXF→glb converter involvement) so the tests run hermetically without a
live converter service.

| File | Bytes | Geometry | Purpose |
| --- | ---: | --- | --- |
| `terrain-simple.glb` | 664 | One triangle in the XZ plane (3 vertices, 1 face) | Smallest geometry that still loads through `GLTFLoader.parse` — used for the "viewer renders one ready source" happy path. |
| `buildable-envelope-simple.glb` | 804 | Axis-aligned box, 8 vertices, 12 triangles | Multi-primitive scene that exercises per-variant material override on a non-trivial mesh. |
| `malformed.glb` | 36 | Valid glb header, broken JSON chunk | Drives the "loader rejects → per-source error pill" branch without needing the network stack. |

The good fixtures encode only POSITION + indices — no materials,
animations, textures, skins, or PBR — so the viewer's per-variant
material override (Lambert / translucent warm / glassy / etc.) is the
only material applied. This matches the Spec 52 §2 contract: glb is
geometry-only, the viewer paints it.

## Regenerating

The files were emitted by a one-off Node script; the math is small
enough that a regen script doesn't earn its keep. If a fixture goes
stale, hand-edit the JSON chunk in a glb inspector or write a fresh
node one-liner — keep them under 1 KB so the repo stays small.
