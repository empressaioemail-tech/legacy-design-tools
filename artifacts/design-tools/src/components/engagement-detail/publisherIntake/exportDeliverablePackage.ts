import type { SheetSummary } from "@workspace/api-client-react";
import type { PublisherIntakeForm } from "./types";
import type {
  PublisherPackageManifestItem,
  PublisherPackageSelection,
} from "./packageTypes";
import { buildDeliverablePackageZip } from "./buildDeliverablePackageZip";

export async function exportDeliverablePackage(
  form: PublisherIntakeForm,
  engagementName: string,
  selection: PublisherPackageSelection,
  items: PublisherPackageManifestItem[],
  sheets: SheetSummary[],
  onProgress?: (message: string) => void,
): Promise<void> {
  await buildDeliverablePackageZip({
    form,
    engagementName,
    selection,
    items,
    sheets,
    onProgress,
  });
}
