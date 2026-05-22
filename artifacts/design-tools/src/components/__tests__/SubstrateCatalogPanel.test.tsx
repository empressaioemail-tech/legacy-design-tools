/**
 * SubstrateCatalogPanel — the QA-17 live-substrate catalog panel.
 *
 * The panel fetches `/api/substrate/jurisdictions` on mount; we stub
 * `fetch` so the test is deterministic and offline.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SubstrateCatalogPanel } from "../SubstrateCatalogPanel";

const CATALOG = {
  source: "mock" as const,
  jurisdictions: [
    {
      key: "grand-county-ut",
      displayName: "Grand County, UT",
      atomCount: 290,
      accessPolicy: "public-free" as const,
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: null,
    },
    {
      key: "bastrop-tx",
      displayName: "Bastrop, TX",
      atomCount: 412,
      accessPolicy: "public-free" as const,
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: null,
    },
    {
      key: "bastrop-county-tx",
      displayName: "Bastrop County, TX",
      atomCount: 357,
      accessPolicy: "platform-internal" as const,
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: null,
    },
    {
      key: "elgin-tx",
      displayName: "Elgin, TX",
      atomCount: 268,
      accessPolicy: "platform-internal" as const,
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: null,
    },
    {
      key: "hutto-tx",
      displayName: "Hutto, TX",
      atomCount: 1716,
      accessPolicy: "platform-internal" as const,
      qualityBar: "passing",
      driftStatus: "clean",
      lastRefreshedAt: null,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SubstrateCatalogPanel", () => {
  it("lists all five substrate jurisdictions with atom counts and access badges", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => CATALOG })),
    );

    render(<SubstrateCatalogPanel />);

    // QA-17 success criterion: all five jurisdictions visible.
    await waitFor(() => {
      expect(screen.getByTestId("substrate-count")).toHaveTextContent(
        /5 jurisdictions in the substrate/,
      );
    });
    for (const j of CATALOG.jurisdictions) {
      expect(
        screen.getByTestId(`substrate-jurisdiction-${j.key}`),
      ).toBeInTheDocument();
    }
    // Real atom counts surface (the count cc-agent-AC's mock seeds for Hutto).
    expect(
      screen.getByTestId("substrate-atomcount-hutto-tx"),
    ).toHaveTextContent("1716");
    // The three partnership-pending jurisdictions carry the
    // platform-internal badge; the two public ones carry "Public".
    expect(
      screen.getByTestId("substrate-access-bastrop-county-tx"),
    ).toHaveTextContent(/Platform-internal/i);
    expect(
      screen.getByTestId("substrate-access-grand-county-ut"),
    ).toHaveTextContent(/Public/i);
  });

  it("shows the catalog source tag (fixture vs live)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ ...CATALOG, source: "mcp" }),
      })),
    );
    render(<SubstrateCatalogPanel />);
    await waitFor(() => {
      expect(screen.getByTestId("substrate-source")).toHaveTextContent("live");
    });
  });

  it("surfaces a clear error when the substrate is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({
          error: "substrate_unavailable",
          code: "substrate_unreachable",
          detail: "Hauska MCP server did not respond within 15000 ms",
        }),
      })),
    );

    render(<SubstrateCatalogPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("substrate-error")).toBeInTheDocument();
    });
    expect(screen.getByTestId("substrate-error")).toHaveTextContent(
      /did not respond/,
    );
  });
});
