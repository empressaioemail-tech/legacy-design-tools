/**
 * Investor verdict reframe — deal / worth a look / dead (75i task 6).
 */

import type { BuyBoxParams } from "./brokeragePencilsAt";
import { computePencilsAt, extractPencilsInputsFromLayers } from "./brokeragePencilsAt";
import type { BrokerageSiteContextLayer } from "./brokerageSiteContext";
import { summarizeMudPidExposure } from "./mudPidRegistry";

export type InvestorVerdictStatus = "deal" | "worth_a_look" | "dead";

export interface InvestorVerdict {
  status: InvestorVerdictStatus;
  headline: string;
  rationale: string[];
  killFactors: string[];
  opportunityFactors: string[];
  ozLine: string | null;
  mudPidLine: string | null;
  generatedAt: string;
}

export interface InvestorProfileBuyBox {
  capRateFloor: number;
  rehabPerSf: number;
  rentSpreadTolerance: number;
}

const DEFAULT_BUY_BOX: InvestorProfileBuyBox = {
  capRateFloor: 0.08,
  rehabPerSf: 35,
  rentSpreadTolerance: 0.05,
};

export function buildInvestorVerdict(input: {
  layers: BrokerageSiteContextLayer[];
  corpusStatus: string;
  buyBox?: InvestorProfileBuyBox | null;
  finishedAt: string;
}): InvestorVerdict {
  const buyBox: BuyBoxParams = {
    ...DEFAULT_BUY_BOX,
    ...input.buyBox,
  };

  const pencilsInputs = extractPencilsInputsFromLayers(input.layers);
  const pencils = computePencilsAt({
    buyBox,
    ...pencilsInputs,
  });

  const killFactors: string[] = [];
  const opportunityFactors: string[] = [];

  const mudLayer = input.layers.find(
    (l) => l.layerKind === "cotality-liens-mortgage-tax" && l.status === "ok",
  );
  const mudFlags = (
    mudLayer?.payload?.mudPidAssessment as
      | { mudPidDetected?: boolean; specialDistrictLabels?: string[] }
      | undefined
  );
  const mudSummary = summarizeMudPidExposure({
    cotalityFlags: mudFlags
      ? {
          mudPidDetected: Boolean(mudFlags.mudPidDetected),
          specialDistrictLabels: mudFlags.specialDistrictLabels ?? [],
        }
      : undefined,
    taxText: JSON.stringify(mudLayer?.payload?.taxAssessment ?? ""),
  });
  if (mudSummary.exposure !== "none") {
    killFactors.push("MUD/PID or special-district assessment exposure flagged");
  }

  const floodLayer = input.layers.find(
    (l) =>
      l.layerKind.includes("flood") ||
      l.adapterKey.includes("fema") ||
      l.adapterKey.includes("cotality:hazards"),
  );
  if (
    floodLayer?.summary &&
    /high.?risk|special flood|zone\s*[ab]/i.test(floodLayer.summary)
  ) {
    killFactors.push("Elevated flood exposure on federal or modeled layers");
  }

  const ozLayer = input.layers.find((l) => l.layerKind === "opportunity-zone");
  const ozPayload = ozLayer?.payload as
    | {
        inOpportunityZone?: boolean;
        tractGeoid?: string | null;
        ozRound?: string;
      }
    | undefined;
  const ozLine =
    ozPayload?.inOpportunityZone && ozPayload.tractGeoid
      ? `Opportunity Zone (${ozPayload.ozRound ?? "oz-1.0"}) tract ${ozPayload.tractGeoid} — hold/capital-gains implications need tax counsel.`
      : ozPayload
        ? `Not in a designated Opportunity Zone tract (${ozPayload.ozRound ?? "oz-1.0"} list).`
        : null;
  if (ozPayload?.inOpportunityZone) {
    opportunityFactors.push("OZ designation may affect hold timeline");
  }

  if (input.corpusStatus === "in_corpus" || input.corpusStatus === "partial") {
    opportunityFactors.push("Local code corpus available for rehab/ADU reasoning");
  }

  if (pencils.pencilsAtBasis != null && pencilsInputs.avmMidpoint != null) {
    if (pencils.pencilsAtBasis >= pencilsInputs.avmMidpoint * 0.95) {
      opportunityFactors.push("Buy-box basis aligns with cited AVM midpoint");
    } else {
      killFactors.push("Buy-box basis sits below cited AVM midpoint");
    }
  }

  let status: InvestorVerdictStatus = "worth_a_look";
  if (killFactors.length >= 2) status = "dead";
  else if (killFactors.length === 0 && opportunityFactors.length >= 2) {
    status = "deal";
  }

  const headline =
    status === "deal"
      ? "Looks like a deal on your buy box"
      : status === "dead"
        ? "Probably dead for your criteria"
        : "Worth a closer look";

  const rationale = [
    pencils.narrative,
    ...killFactors.map((k) => `Risk: ${k}`),
    ...opportunityFactors.map((o) => `Upside: ${o}`),
  ];

  const mudPidLine =
    mudSummary.exposure === "none"
      ? "No MUD/PID flags in Cotality tax payload or TX Comptroller registry match."
      : `MUD/PID exposure ${mudSummary.exposure} (${mudSummary.sources.join(", ")})`;

  return {
    status,
    headline,
    rationale,
    killFactors,
    opportunityFactors,
    ozLine,
    mudPidLine,
    generatedAt: input.finishedAt,
  };
}
