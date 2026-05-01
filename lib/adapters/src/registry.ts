/**
 * Adapter registry — the canonical "all the adapters DA-PI-4 ships"
 * list. The api-server's generate-layers route imports {@link
 * ALL_ADAPTERS}; tests can inject a narrower subset directly into the
 * runner.
 *
 * Adding a new adapter is a one-line append here plus the adapter
 * module itself — the runner picks it up automatically and the UI's
 * tier grouping reads `tier` off the adapter contract, so no UI change
 * is required for an additional source within an existing tier.
 */

import type { Adapter } from "./types";
import { femaNfhlAdapter } from "./federal/fema-nfhl";
import { usgsNedAdapter } from "./federal/usgs-ned";
import { epaEjscreenAdapter } from "./federal/epa-ejscreen";
import { fccBroadbandAdapter } from "./federal/fcc-broadband";
import {
  utahDemAdapter,
  utahParcelsAdapter,
  utahAddressPointsAdapter,
} from "./state/utah";
import {
  idahoDemAdapter,
  idahoParcelsAdapter,
} from "./state/idaho";
import { texasEdwardsAquiferAdapter } from "./state/texas";
import {
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
} from "./local/grand-county-ut";
import {
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
} from "./local/lemhi-county-id";
import {
  bastropParcelsAdapter,
  bastropZoningAdapter,
  bastropFloodAdapter,
} from "./local/bastrop-tx";

export const FEDERAL_ADAPTERS: ReadonlyArray<Adapter> = [
  femaNfhlAdapter,
  usgsNedAdapter,
  epaEjscreenAdapter,
  fccBroadbandAdapter,
];

export const STATE_ADAPTERS: ReadonlyArray<Adapter> = [
  utahDemAdapter,
  utahParcelsAdapter,
  utahAddressPointsAdapter,
  idahoDemAdapter,
  idahoParcelsAdapter,
  texasEdwardsAquiferAdapter,
];

export const LOCAL_ADAPTERS: ReadonlyArray<Adapter> = [
  grandCountyParcelsAdapter,
  grandCountyZoningAdapter,
  grandCountyRoadsAdapter,
  lemhiCountyParcelsAdapter,
  lemhiCountyZoningAdapter,
  lemhiCountyRoadsAdapter,
  bastropParcelsAdapter,
  bastropZoningAdapter,
  bastropFloodAdapter,
];

/**
 * The full DA-PI-4 + DA-PI-2 adapter set. Federal adapters lead so the
 * Site Context tab's "Federal layers" group renders before the state
 * and local groups in the order returned by the runner.
 */
export const ALL_ADAPTERS: ReadonlyArray<Adapter> = [
  ...FEDERAL_ADAPTERS,
  ...STATE_ADAPTERS,
  ...LOCAL_ADAPTERS,
];
