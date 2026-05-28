/**
 * Admin graph baseline — consent-aware session dots + share edges.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  db,
  gtmConsent,
  gtmEvents,
  brokerageWorkspaceShares,
} from "@workspace/db";
import { brokerageAdminAuth } from "../middlewares/brokerageAdminAuth";

const GRAPH_WINDOW_DAYS = 30;

export const brokerageAdminGraphRouter: IRouter = Router();

brokerageAdminGraphRouter.use(brokerageAdminAuth);

brokerageAdminGraphRouter.get("/graph", async (req: Request, res: Response) => {
  const since = new Date(Date.now() - GRAPH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const format = String(req.query.format ?? "json");

  const optedIn = await db
    .select({ installId: gtmConsent.installId })
    .from(gtmConsent)
    .where(eq(gtmConsent.graphOptIn, true));

  const optedInSet = new Set(optedIn.map((r) => r.installId));

  const geoEvents = await db
    .select({
      installId: gtmEvents.installId,
      eventType: gtmEvents.eventType,
      payloadJson: gtmEvents.payloadJson,
      createdAt: gtmEvents.createdAt,
    })
    .from(gtmEvents)
    .where(
      and(
        gte(gtmEvents.createdAt, since),
        sql`${gtmEvents.eventType} IN ('session_geo', 'brief_completed')`,
      ),
    )
    .orderBy(desc(gtmEvents.createdAt))
    .limit(500);

  const nodes: Array<{
    id: string;
    lat: number;
    lon: number;
    label: string;
    lastSeenAt: string;
  }> = [];

  const nodeByInstall = new Map<string, (typeof nodes)[number]>();

  for (const ev of geoEvents) {
    if (!optedInSet.has(ev.installId)) continue;
    const payload = (ev.payloadJson ?? {}) as {
      lat?: number;
      lon?: number;
      geocode?: { lat?: number; lon?: number };
    };
    const lat = payload.lat ?? payload.geocode?.lat;
    const lon = payload.lon ?? payload.geocode?.lon;
    if (typeof lat !== "number" || typeof lon !== "number") continue;

    const id = ev.installId.slice(0, 12);
    const existing = nodeByInstall.get(ev.installId);
    if (!existing || ev.createdAt > new Date(existing.lastSeenAt)) {
      nodeByInstall.set(ev.installId, {
        id,
        lat,
        lon,
        label: id,
        lastSeenAt: ev.createdAt.toISOString(),
      });
    }
  }

  nodes.push(...nodeByInstall.values());

  const shareRows = await db
    .select({
      ownerInstallId: brokerageWorkspaceShares.ownerInstallId,
      collaboratorInstallId: brokerageWorkspaceShares.collaboratorInstallId,
      createdAt: brokerageWorkspaceShares.createdAt,
    })
    .from(brokerageWorkspaceShares)
    .where(
      and(
        gte(brokerageWorkspaceShares.createdAt, since),
        isNull(brokerageWorkspaceShares.revokedAt),
      ),
    )
    .limit(200);

  const edges: Array<{
    from: string;
    to: string;
    kind: "share";
    createdAt: string;
  }> = [];

  for (const row of shareRows) {
    if (!optedInSet.has(row.ownerInstallId)) continue;
    const from = row.ownerInstallId.slice(0, 12);
    const to = (row.collaboratorInstallId ?? "anonymous").slice(0, 12);
    edges.push({
      from,
      to,
      kind: "share",
      createdAt: row.createdAt.toISOString(),
    });
  }

  const graph = {
    windowDays: GRAPH_WINDOW_DAYS,
    since: since.toISOString(),
    consentFiltered: true,
    nodes,
    edges,
  };

  if (format === "html") {
    const html = renderGraphHtml(graph);
    res.type("html").send(html);
    return;
  }

  res.json(graph);
});

function renderGraphHtml(graph: {
  windowDays: number;
  nodes: Array<{ id: string; lat: number; lon: number; label: string }>;
  edges: Array<{ from: string; to: string }>;
}): string {
  const nodeJson = JSON.stringify(graph.nodes);
  const edgeJson = JSON.stringify(graph.edges);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Brokerage admin graph</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 1rem; background: #0b1220; color: #e2e8f0; }
    h1 { font-size: 1.1rem; }
    .meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 1rem; }
    pre { background: #1e293b; padding: 1rem; border-radius: 8px; overflow: auto; max-height: 40vh; }
    .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #3b82f6; margin-right: 6px; }
  </style>
</head>
<body>
  <h1><span class="dot"></span>Brokerage graph (${graph.windowDays}d, consent-filtered)</h1>
  <p class="meta">Nodes = session geography (graphOptIn). Edges = workspace shares.</p>
  <h2>Nodes (${graph.nodes.length})</h2>
  <pre id="nodes"></pre>
  <h2>Edges (${graph.edges.length})</h2>
  <pre id="edges"></pre>
  <script>
    const nodes = ${nodeJson};
    const edges = ${edgeJson};
    document.getElementById('nodes').textContent = JSON.stringify(nodes, null, 2);
    document.getElementById('edges').textContent = JSON.stringify(edges, null, 2);
  </script>
</body>
</html>`;
}
