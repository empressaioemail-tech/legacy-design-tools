import { describe, it, expect } from "vitest";
import { act } from "react";

// react's `act` needs this flag set for the state-update-in-act path.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { render, screen } from "@testing-library/react";
import {
  EngagementProvider,
  useEngagement,
  type EngagementDetail,
} from "@empressaio/tile-shell";

// A headless probe that exposes the shared active-parcel + the three setters.
let api: ReturnType<typeof useEngagement>;
function Probe() {
  api = useEngagement();
  const p = api.activeParcel;
  return (
    <div>
      <span data-testid="apn">{p.apn ?? "∅"}</span>
      <span data-testid="jur">{p.jurisdiction ?? "∅"}</span>
      <span data-testid="lat">{p.lat ?? "∅"}</span>
      <span data-testid="lng">{p.lng ?? "∅"}</span>
      <span data-testid="eid">{p.engagementId ?? "∅"}</span>
    </div>
  );
}

const E1: EngagementDetail = {
  id: "eng-1",
  name: "E1",
  jurisdiction: "grand-county",
  address: "1 First St",
  apn: "APN-1",
  applicantName: null,
  latitude: 38.5,
  longitude: -109.5,
  reportResults: {},
};

function setup() {
  render(
    <EngagementProvider>
      <Probe />
    </EngagementProvider>,
  );
}

describe("shared active-parcel context", () => {
  it("engagement selection (setter #1) drives the active parcel", () => {
    setup();
    act(() => api.setEngagement("eng-1", E1));
    expect(screen.getByTestId("apn").textContent).toBe("APN-1");
    expect(screen.getByTestId("jur").textContent).toBe("grand-county");
    expect(screen.getByTestId("eid").textContent).toBe("eng-1");
  });

  it("address search (setter #2) wins over a loaded engagement's parcel", () => {
    setup();
    act(() => api.setEngagement("eng-1", E1));
    // Address search returns a bare parcel (engagementId: null) — must supersede
    // the loaded engagement's parcel identity (the regression this guards).
    act(() =>
      api.setActiveParcel({
        engagementId: null,
        apn: "APN-2",
        jurisdiction: "bastrop-tx",
        address: "2 Second Ave",
        lat: 30.11,
        lng: -97.32,
      }),
    );
    expect(screen.getByTestId("lat").textContent).toBe("30.11");
    expect(screen.getByTestId("lng").textContent).toBe("-97.32");
    expect(screen.getByTestId("jur").textContent).toBe("bastrop-tx");
    expect(screen.getByTestId("apn").textContent).toBe("APN-2");
    // Engagement id is preserved so engagement-scoped tiles still resolve.
    expect(screen.getByTestId("eid").textContent).toBe("eng-1");
  });

  it("map-click (setter #3) sets a coordinate-bearing parcel without an engagement", () => {
    setup();
    act(() =>
      api.setActiveParcel({ apn: "APN-9", lat: 40.1, lng: -111.2 }),
    );
    expect(screen.getByTestId("lat").textContent).toBe("40.1");
    expect(screen.getByTestId("apn").textContent).toBe("APN-9");
    expect(screen.getByTestId("eid").textContent).toBe("∅");
  });

  it("a coordinate-less override does not clobber the engagement parcel", () => {
    setup();
    act(() => api.setEngagement("eng-1", E1));
    act(() => api.setActiveParcel({ apn: "APN-ONLY" }));
    // No lat/lng on the override → engagement stays the spatial authority.
    expect(screen.getByTestId("lat").textContent).toBe("38.5");
    expect(screen.getByTestId("eid").textContent).toBe("eng-1");
  });

  it("selecting a new engagement clears a prior parcel override", () => {
    setup();
    act(() => api.setActiveParcel({ apn: "APN-X", lat: 1, lng: 2 }));
    act(() => api.setEngagement("eng-1", E1));
    expect(screen.getByTestId("lat").textContent).toBe("38.5");
    expect(screen.getByTestId("apn").textContent).toBe("APN-1");
  });
});
