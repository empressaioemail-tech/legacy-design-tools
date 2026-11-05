import { iccNoticeFor, type IccNotice } from "@workspace/icc-notice";

/**
 * G-309 (ICC Exhibit B): `{ iccNotice }` to spread into a response body that
 * carries citations, or `{}` when no ICC citation is present.
 *
 * `citationLists` are lists whose entries are citations or sources (strings,
 * links, provenance entries). `containerLists` are lists of objects (brief
 * sections) judged only by the `citations` array they hold.
 */
export function iccNoticeField(
  citationLists: unknown[],
  containerLists: unknown[] = [],
): { iccNotice?: IccNotice } {
  const flat: unknown[] = [];
  for (const list of citationLists) {
    if (Array.isArray(list)) flat.push(...list);
  }
  for (const list of containerLists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const nested = (entry as { citations?: unknown } | null)?.citations;
      if (Array.isArray(nested)) flat.push(...nested);
    }
  }
  const notice = iccNoticeFor(flat);
  return notice ? { iccNotice: notice } : {};
}
