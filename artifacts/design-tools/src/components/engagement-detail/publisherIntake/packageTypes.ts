/** Selected assets for publisher handoff. */
export interface PublisherPackageSelection {
  includeIntake: boolean;
  renderIds: string[];
  videoIds: string[];
  sheetIds: string[];
}

export function emptyPublisherPackageSelection(): PublisherPackageSelection {
  return {
    includeIntake: true,
    renderIds: [],
    videoIds: [],
    sheetIds: [],
  };
}

export interface PublisherPackageManifestItem {
  type: "intake" | "rendering" | "video" | "plan";
  id: string;
  label: string;
  status?: string;
  kind?: string;
}

export interface PublisherPackageManifest {
  engagementName: string;
  exportedAt: string;
  includeIntake: boolean;
  itemCount: number;
  items: PublisherPackageManifestItem[];
}
