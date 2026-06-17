/**
 * Central TX adopted I-Code packages (61a batched edition-verification).
 * Layer 1/2 reasoning warm — manifest lists per jurisdiction.
 */

/** @type {Record<string, { label: string; adoptedEditions: string; manifests: string[]; deepenManifests?: string[]; secFloors?: string; preDeepen?: { verifiedRate: number; families?: Record<string, number> } }>} */
export const CENTRAL_TX_ADOPTION = {
  austin_tx: {
    label: "Austin, TX",
    adoptedEditions:
      "IRC/IBC/IECC/IFC 2024 + UMC/UPC 2024 + A117.1 + NEC 2023 deeplink + TAS 2012",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_umc_upc_2024.yaml",
      "manifest_accessibility_austin_2024.yaml",
      "manifest_tas_2012.yaml",
    ],
    deepenManifests: [
      "manifest_umc_upc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_accessibility_austin_2024.yaml",
      "manifest_tas_2012.yaml",
    ],
    preDeepen: {
      verifiedRate: 38.6,
      families: {
        "A117.1 2017": 80.4,
        "IBC 2024": 66.3,
        "IRC 2024": 31.6,
      },
    },
  },
  san_antonio_tx: {
    label: "San Antonio, TX",
    adoptedEditions: "IRC/IBC/IFC 2024 + IECC 2021 (excluded from 2024 cycle)",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_iecc_2021.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
    deepenManifests: [
      "manifest_ifc_2024.yaml",
      "manifest_iecc_2021.yaml",
    ],
    preDeepen: { verifiedRate: 0 },
  },
  round_rock_tx: {
    label: "Round Rock, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  georgetown_tx: {
    label: "Georgetown, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  hutto_tx: {
    label: "Hutto, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  leander_tx: {
    label: "Leander, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  new_braunfels_tx: {
    label: "New Braunfels, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  dripping_springs_tx: {
    label: "Dripping Springs, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2024 + IMC/IPC/IFGC 2021",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2024.yaml",
      "manifest_ibc_2024.yaml",
      "manifest_iecc_2024.yaml",
      "manifest_ifc_2024.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  killeen_tx: {
    label: "Killeen, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2021 package (2021 adoption)",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2021.yaml",
      "manifest_ibc_iebc_2021.yaml",
      "manifest_iecc_2021.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_ifc_ipmc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  schertz_tx: {
    label: "Schertz, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2021 package",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2021.yaml",
      "manifest_ibc_iebc_2021.yaml",
      "manifest_iecc_2021.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_ifc_ipmc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
  boerne_tx: {
    label: "Boerne, TX",
    adoptedEditions: "IRC/IBC/IECC/IFC 2021 package",
    secFloors: "SECO 2015 IRC Ch.11 res / 2015 IECC commercial; TAS 2012",
    manifests: [
      "manifest_irc_2021.yaml",
      "manifest_ibc_iebc_2021.yaml",
      "manifest_iecc_2021.yaml",
      "manifest_imc_ipc_ifgc_2021.yaml",
      "manifest_ifc_ipmc_2021.yaml",
      "manifest_accessibility_nfpa_2021.yaml",
    ],
  },
};

/** Jurisdictions touched by the broken deepen batch (audit + repair). */
export const DEEPEN_TOUCHED_JURISDICTIONS = ["austin_tx", "san_antonio_tx"];

/** Priority deepen order (61a proof wave + corridor). */
export const DEEPEN_PRIORITY = [
  "austin_tx",
  "san_antonio_tx",
  "round_rock_tx",
  "georgetown_tx",
  "hutto_tx",
  "leander_tx",
  "new_braunfels_tx",
  "dripping_springs_tx",
  "killeen_tx",
  "schertz_tx",
  "boerne_tx",
];

/** Class B Municode onboards — reasoning deepen after L3 onboard. */
export const CLASS_B_ONBOARD_PENDING = [
  "waco_tx",
  "temple_tx",
  "san_marcos_tx",
  "seguin_tx",
  "cibolo_tx",
  "belton_tx",
  "universal_city_tx",
];
