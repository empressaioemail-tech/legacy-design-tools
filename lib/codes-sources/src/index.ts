export * from "./types";
export { grandCountyHtmlSource } from "./grandCountyHtml";
export { grandCountyPdfSource } from "./grandCountyPdf";
export { municodeSource } from "./municode";

import { grandCountyHtmlSource } from "./grandCountyHtml";
import { grandCountyPdfSource } from "./grandCountyPdf";
import { municodeSource } from "./municode";
import type { CodeSource } from "./types";

const REGISTRY: Record<string, CodeSource> = {
  [grandCountyHtmlSource.id]: grandCountyHtmlSource,
  [grandCountyPdfSource.id]: grandCountyPdfSource,
  [municodeSource.id]: municodeSource,
};

export function getSource(sourceName: string): CodeSource | null {
  return REGISTRY[sourceName] ?? null;
}

export function listSources(): CodeSource[] {
  return Object.values(REGISTRY);
}
