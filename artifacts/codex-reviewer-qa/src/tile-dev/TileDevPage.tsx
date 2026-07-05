import { getTile } from "../tile-shell/tiles";
import { EngagementProvider } from "@empressaio/tile-shell";
import { SpatialProvider } from "@empressaio/tile-shell";
import { CodeProvider } from "@empressaio/tile-shell";

export default function TileDevPage({ tileId }: { tileId: string }) {
  const def = getTile(tileId);

  if (!def) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Unknown tile: {tileId}</h1>
      </main>
    );
  }

  return (
    <EngagementProvider>
      <SpatialProvider>
        <CodeProvider>
          <main
            data-testid="tile-dev-page"
            style={{
              maxWidth: 960,
              margin: "0 auto",
              padding: 16,
              minHeight: "100vh",
            }}
          >
            <h1 style={{ fontSize: 18, marginBottom: 12 }}>
              Tile dev — {def.label}
            </h1>
            <div
              style={{
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                minHeight: 400,
              }}
            >
              {def.el()}
            </div>
          </main>
        </CodeProvider>
      </SpatialProvider>
    </EngagementProvider>
  );
}
