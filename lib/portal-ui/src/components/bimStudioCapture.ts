/** Camera + GLB snapshot from BimModelViewport for Studio still kickoff. */
export interface BimStudioCapture {
  glbUrl: string;
  cameraPosition: { x: number; y: number; z: number };
  cameraTarget: { x: number; y: number; z: number };
  fov?: number;
}

export function formatVec3(v: { x: number; y: number; z: number }): string {
  return `${v.x},${v.y},${v.z}`;
}

export function parseVec3Csv(raw: string): { x: number; y: number; z: number } | null {
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0], y: parts[1], z: parts[2] };
}
