/** Provenance for auto-filled publisher intake fields (Exhibit C). */
export type PublisherFieldSource =
  | "engagement"
  | "site"
  | "briefing"
  | "model"
  | "demo"
  | "manual";

export type PublisherPlanType =
  | "single_family"
  | "multi_family"
  | "duplex"
  | "garage"
  | "";

export type PublisherStoryCount = "1" | "1.5" | "2" | "3" | "";

export interface PublisherIntakeRoomRow {
  id: string;
  name: string;
  width: string;
  depth: string;
  ceilingHeight: string;
  ceilingType: string;
}

/** Exhibit C — New Plan Information Sheet (ABHP publisher intake). */
export interface PublisherIntakeForm {
  designerName: string;
  designerPlanNumber: string;
  designerPlanName: string;
  formDate: string;
  abhpNumber: string;
  planType: PublisherPlanType;
  numberOfStories: PublisherStoryCount;
  numberOfBedrooms: string;
  numberOfFullBaths: string;
  numberOfHalfBaths: string;
  garageTypes: string[];
  garageStalls: string;
  mainRoofPitch: string;
  sqftFirstFloor: string;
  sqftSecondFloor: string;
  sqftThirdFloor: string;
  sqftBasement: string;
  sqftGarage: string;
  sqftBonusRoom: string;
  sqftTotalHeated: string;
  widthFeetInches: string;
  depthFeetInches: string;
  heightFeetInches: string;
  porchTypes: string[];
  foundations: string[];
  architecturalStyles: string[];
  otherSuggestedStyles: string;
  planFeatures: string[];
  houseDescription: string;
  rooms: PublisherIntakeRoomRow[];
  planProductsPricing: Record<string, string>;
  cadFileFormats: string;
}

export type PublisherIntakeFieldKey = keyof PublisherIntakeForm;

export type PublisherFieldSources = Partial<
  Record<PublisherIntakeFieldKey, PublisherFieldSource>
>;
