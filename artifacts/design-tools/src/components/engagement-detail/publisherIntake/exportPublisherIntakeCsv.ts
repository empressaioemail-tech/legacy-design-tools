import { PUBLISHER_PLAN_PRODUCTS } from "./exhibitCConstants";
import type { PublisherIntakeForm } from "./types";

function csvCell(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

/** Export Exhibit C intake as CSV for publisher handoff (Excel / Sheets). */
export function exportPublisherIntakeCsv(
  form: PublisherIntakeForm,
  engagementName: string,
): string {
  const rows: string[][] = [
    ["Exhibit C - New Plan Information Sheet"],
    ["Designer Name", form.designerName],
    ["Designer Plan Number", form.designerPlanNumber],
    ["Designer Plan Name", form.designerPlanName],
    ["Date", form.formDate],
    ["ABHP Number", form.abhpNumber],
    [],
    ["Plan Type", form.planType],
    ["Number of Stories", form.numberOfStories],
    ["Bedrooms", form.numberOfBedrooms],
    ["Full Baths", form.numberOfFullBaths],
    ["Half Baths", form.numberOfHalfBaths],
    ["Garage Types", form.garageTypes.join("; ")],
    ["Garage Stalls", form.garageStalls],
    ["Main Roof Pitch", form.mainRoofPitch ? `${form.mainRoofPitch}/12` : ""],
    [],
    ["Square Footage"],
    ["First Floor", form.sqftFirstFloor],
    ["Second Floor", form.sqftSecondFloor],
    ["Third Floor", form.sqftThirdFloor],
    ["Basement", form.sqftBasement],
    ["Garage", form.sqftGarage],
    ["Bonus Room", form.sqftBonusRoom],
    ["Total Heated", form.sqftTotalHeated],
    [],
    ["Measurements (Feet-Inches)"],
    ["Width", form.widthFeetInches],
    ["Depth", form.depthFeetInches],
    ["Height", form.heightFeetInches],
    [],
    ["Porch Types", form.porchTypes.join("; ")],
    ["Foundations", form.foundations.join("; ")],
    ["Architectural Styles", form.architecturalStyles.join("; ")],
    ["Other Styles", form.otherSuggestedStyles],
    [],
    ["Plan Features", form.planFeatures.join("; ")],
    [],
    ["Description of House", form.houseDescription],
    [],
    ["Plan Products and Pricing"],
    ...PUBLISHER_PLAN_PRODUCTS.map((product) => [
      product,
      form.planProductsPricing[product] ?? "",
    ]),
    ["CAD File Formats", form.cadFileFormats],
    [],
    ["Room Schedule"],
    ["Room", "Width", "Depth", "Ceiling Height", "Ceiling Type"],
    ...form.rooms.map((r) => [
      r.name,
      r.width,
      r.depth,
      r.ceilingHeight,
      r.ceilingType,
    ]),
    [],
    ["Engagement", engagementName],
  ];

  return rows.map((row) => row.map((c) => csvCell(c)).join(",")).join("\r\n");
}

export function downloadPublisherIntakeCsv(
  form: PublisherIntakeForm,
  engagementName: string,
): void {
  const csv = exportPublisherIntakeCsv(form, engagementName);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const slug = engagementName.replace(/[^\w.-]+/g, "-").slice(0, 48);
  anchor.download = `${slug || "plan"}-publisher-intake.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
