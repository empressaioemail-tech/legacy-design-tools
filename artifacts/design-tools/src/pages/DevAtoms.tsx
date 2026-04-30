/**
 * /dev/atoms — Atom Inspector.
 *
 * Operator/debug surface, intentionally separate from the consumer-facing
 * Code Library page. Where Code Library is "browse public-record code by
 * jurisdiction with rich card UX," this is a flat, searchable, paginated
 * table of every atom in the database with filters not exposed in the
 * consumer view (sourceName, embedded vs raw, free-text section search).
 *
 * Filter and pagination state is mirrored into the URL querystring so the
 * page is shareable: `?jurisdictionKey=…&codeBook=…&q=…&offset=…`. The
 * URL is the source of truth for filters; reading on mount and writing
 * on change keeps a single direction of data flow (URL → state → query).
 */
import { useEffect, useMemo, useState } from "react";
import {
  useListCodeAtoms,
  useGetCodeAtom,
  useListCodeJurisdictions,
  getListCodeAtomsQueryKey,
  getGetCodeAtomQueryKey,
  getListCodeJurisdictionsQueryKey,
  type ListCodeAtomsParams,
} from "@workspace/api-client-react";
import { ExternalLink, X } from "lucide-react";

const PAGE_SIZE = 50;

type EmbeddedFilter = "all" | "true" | "false";

interface FilterState {
  jurisdictionKey: string;
  codeBook: string;
  edition: string;
  sourceName: string;
  embedded: EmbeddedFilter;
  q: string;
  offset: number;
}

const DEFAULT_FILTERS: FilterState = {
  jurisdictionKey: "",
  codeBook: "",
  edition: "",
  sourceName: "",
  embedded: "all",
  q: "",
  offset: 0,
};

function readFiltersFromUrl(): FilterState {
  const params = new URLSearchParams(window.location.search);
  const embeddedRaw = params.get("embedded") ?? "";
  const embedded: EmbeddedFilter =
    embeddedRaw === "true" || embeddedRaw === "false" ? embeddedRaw : "all";
  const offsetN = Number(params.get("offset") ?? "0");
  return {
    jurisdictionKey: params.get("jurisdictionKey") ?? "",
    codeBook: params.get("codeBook") ?? "",
    edition: params.get("edition") ?? "",
    sourceName: params.get("sourceName") ?? "",
    embedded,
    q: params.get("q") ?? "",
    offset: Number.isFinite(offsetN) && offsetN > 0 ? Math.floor(offsetN) : 0,
  };
}

function writeFiltersToUrl(f: FilterState): void {
  const params = new URLSearchParams();
  if (f.jurisdictionKey) params.set("jurisdictionKey", f.jurisdictionKey);
  if (f.codeBook) params.set("codeBook", f.codeBook);
  if (f.edition) params.set("edition", f.edition);
  if (f.sourceName) params.set("sourceName", f.sourceName);
  if (f.embedded !== "all") params.set("embedded", f.embedded);
  if (f.q) params.set("q", f.q);
  if (f.offset > 0) params.set("offset", String(f.offset));
  const qs = params.toString();
  const next = qs ? `?${qs}` : window.location.pathname;
  // Use replaceState so back button doesn't fill up with intermediate
  // filter states — the inspector is an exploratory tool.
  window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  void next;
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function DevAtoms() {
  const [filters, setFilters] = useState<FilterState>(() =>
    readFiltersFromUrl(),
  );
  const [activeAtomId, setActiveAtomId] = useState<string | null>(null);

  // Sync filters → URL whenever they change.
  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  // Build query params for the list endpoint. Only include keys that have
  // actual values so the query key (and therefore React Query cache hits)
  // stay tight.
  const listParams: ListCodeAtomsParams = useMemo(() => {
    const p: ListCodeAtomsParams = { limit: PAGE_SIZE, offset: filters.offset };
    if (filters.jurisdictionKey) p.jurisdictionKey = filters.jurisdictionKey;
    if (filters.codeBook) p.codeBook = filters.codeBook;
    if (filters.edition) p.edition = filters.edition;
    if (filters.sourceName) p.sourceName = filters.sourceName;
    if (filters.embedded !== "all") p.embedded = filters.embedded;
    if (filters.q.trim()) p.q = filters.q.trim();
    return p;
  }, [filters]);

  const atomsQuery = useListCodeAtoms(listParams, {
    query: {
      queryKey: getListCodeAtomsQueryKey(listParams),
      // Modest poll so newly-warmed atoms show up without a manual refresh,
      // but slow enough not to hammer the DB while an operator is reading.
      refetchInterval: 10_000,
      placeholderData: (prev) => prev,
    },
  });

  // Clamp out-of-range offsets back to 0 once the server tells us the real
  // total. Catches deep-linked URLs like `?offset=500` against a smaller
  // result set, which would otherwise render incoherent "501–500 of 264".
  useEffect(() => {
    const t = atomsQuery.data?.total;
    if (typeof t === "number" && t > 0 && filters.offset >= t) {
      setFilters((cur) => ({ ...cur, offset: 0 }));
    }
  }, [atomsQuery.data?.total, filters.offset]);

  // Jurisdictions feed the source/codeBook dropdowns so the operator
  // doesn't have to memorize keys. We tolerate the request being optional —
  // the inspector still works with raw text inputs if this 404s.
  const jurisdictionsQuery = useListCodeJurisdictions({
    query: {
      queryKey: getListCodeJurisdictionsQueryKey(),
      staleTime: 60_000,
    },
  });

  const jurisdictionOptions = useMemo(() => {
    const list = jurisdictionsQuery.data ?? [];
    return list.map((j) => ({ key: j.key, label: j.displayName }));
  }, [jurisdictionsQuery.data]);

  const sourceOptions = useMemo(() => {
    const list = jurisdictionsQuery.data ?? [];
    const seen = new Set<string>();
    for (const j of list) {
      if (filters.jurisdictionKey && j.key !== filters.jurisdictionKey)
        continue;
      for (const b of j.books) seen.add(b.sourceName);
    }
    return Array.from(seen).sort();
  }, [jurisdictionsQuery.data, filters.jurisdictionKey]);

  const codeBookOptions = useMemo(() => {
    const list = jurisdictionsQuery.data ?? [];
    const seen = new Set<string>();
    for (const j of list) {
      if (filters.jurisdictionKey && j.key !== filters.jurisdictionKey)
        continue;
      for (const b of j.books) seen.add(b.codeBook);
    }
    return Array.from(seen).sort();
  }, [jurisdictionsQuery.data, filters.jurisdictionKey]);

  // Atom detail (right pane) — only fetched when a row is selected.
  const atomDetailQuery = useGetCodeAtom(activeAtomId ?? "", {
    query: {
      enabled: !!activeAtomId,
      queryKey: activeAtomId
        ? getGetCodeAtomQueryKey(activeAtomId)
        : ["codes", "atom", "none"],
    },
  });

  const total = atomsQuery.data?.total ?? 0;
  const items = atomsQuery.data?.items ?? [];
  const embeddedInPage = items.filter((a) => a.embedded).length;
  const rawInPage = items.length - embeddedInPage;
  const startIdx = total === 0 ? 0 : filters.offset + 1;
  const endIdx = filters.offset + items.length;
  const hasPrev = filters.offset > 0;
  const hasNext = filters.offset + items.length < total;

  // Setter helper: any filter change resets offset to 0 (otherwise we'd
  // commonly land on an empty page after narrowing the result set) and
  // clears the open detail pane (the previously-selected atom may not be
  // in the new result set, which would be visually misleading).
  function patch(p: Partial<FilterState>): void {
    setFilters((cur) => ({ ...cur, ...p, offset: 0 }));
    setActiveAtomId(null);
  }

  function changeOffset(delta: number): void {
    setFilters((cur) => ({
      ...cur,
      offset: Math.max(0, cur.offset + delta),
    }));
  }

  function clearAllFilters(): void {
    setFilters({ ...DEFAULT_FILTERS });
  }

  const anyFilterActive =
    !!filters.jurisdictionKey ||
    !!filters.codeBook ||
    !!filters.edition ||
    !!filters.sourceName ||
    filters.embedded !== "all" ||
    !!filters.q;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl">Atom Inspector</h1>
        <p className="sc-body opacity-80">
          Flat, filterable view of every code atom in the database. Use the
          consumer-facing{" "}
          <a className="underline" href="../code-library">
            Code Library
          </a>{" "}
          for the per-jurisdiction browsing experience.
        </p>
      </header>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded border border-zinc-700 p-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Jurisdiction</span>
          <select
            className="rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.jurisdictionKey}
            onChange={(e) => patch({ jurisdictionKey: e.target.value })}
          >
            <option value="">All jurisdictions</option>
            {jurisdictionOptions.map((j) => (
              <option key={j.key} value={j.key}>
                {j.label} ({j.key})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Code book</span>
          <select
            className="rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.codeBook}
            onChange={(e) => patch({ codeBook: e.target.value })}
          >
            <option value="">All code books</option>
            {codeBookOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Edition</span>
          <input
            type="text"
            placeholder="(any)"
            className="w-24 rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.edition}
            onChange={(e) => patch({ edition: e.target.value })}
          />
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Source</span>
          <select
            className="rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.sourceName}
            onChange={(e) => patch({ sourceName: e.target.value })}
          >
            <option value="">All sources</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Embedded</span>
          <select
            className="rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.embedded}
            onChange={(e) =>
              patch({ embedded: e.target.value as EmbeddedFilter })
            }
          >
            <option value="all">All</option>
            <option value="true">Embedded only</option>
            <option value="false">Raw only</option>
          </select>
        </label>

        <label className="flex flex-1 flex-col gap-1 text-xs">
          <span className="opacity-70">Search section number / title</span>
          <input
            type="text"
            placeholder="e.g. R301 or Wind Loads"
            className="rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.q}
            onChange={(e) => patch({ q: e.target.value })}
          />
        </label>

        {anyFilterActive && (
          <button
            type="button"
            onClick={clearAllFilters}
            className="flex items-center gap-1 rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {/* Stats strip */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span className="opacity-80">
          {atomsQuery.isLoading ? (
            "Loading…"
          ) : total === 0 ? (
            <strong>No atoms match.</strong>
          ) : (
            <>
              <strong>{startIdx}</strong>–<strong>{endIdx}</strong> of{" "}
              <strong>{total}</strong>
            </>
          )}
        </span>
        {items.length > 0 && (
          <>
            <span className="opacity-60">
              on this page: {embeddedInPage} embedded · {rawInPage} raw
            </span>
          </>
        )}
        {atomsQuery.error && (
          <span className="text-red-400">Failed to load atoms.</span>
        )}
      </div>

      {/* Two-column layout: table on left, detail on right when a row is selected */}
      <div className="flex gap-4">
        <div className="flex-1 overflow-auto rounded border border-zinc-700">
          <table className="w-full table-auto text-sm">
            <thead className="sticky top-0 bg-zinc-900 text-xs uppercase opacity-80">
              <tr>
                <th className="px-2 py-2 text-left">Section</th>
                <th className="px-2 py-2 text-left">Title</th>
                <th className="px-2 py-2 text-left">Jurisdiction</th>
                <th className="px-2 py-2 text-left">Book · Edition</th>
                <th className="px-2 py-2 text-left">Source</th>
                <th className="px-2 py-2 text-left">Vec</th>
                <th className="px-2 py-2 text-left">Fetched</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => {
                const isActive = a.id === activeAtomId;
                return (
                  <tr
                    key={a.id}
                    onClick={() => setActiveAtomId(a.id)}
                    className={
                      "cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/50 " +
                      (isActive ? "bg-zinc-800" : "")
                    }
                  >
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                      {a.sectionNumber ?? "—"}
                    </td>
                    <td className="px-2 py-1">{a.sectionTitle ?? "—"}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                      {a.jurisdictionKey}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                      {a.codeBook} · {a.edition}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                      {a.sourceName}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-xs">
                      <span
                        className={
                          "rounded px-1.5 py-0.5 " +
                          (a.embedded
                            ? "bg-emerald-900 text-emerald-200"
                            : "bg-zinc-700 text-zinc-300")
                        }
                      >
                        {a.embedded ? "vec" : "raw"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1 text-xs opacity-70">
                      {relativeTime(a.fetchedAt)}
                    </td>
                  </tr>
                );
              })}
              {!atomsQuery.isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-2 py-6 text-center opacity-60">
                    No atoms match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {activeAtomId && (
          <aside className="w-[40%] max-w-[640px] overflow-auto rounded border border-zinc-700 p-3">
            <div className="mb-2 flex items-start justify-between gap-2">
              <h2 className="text-base font-semibold">Atom detail</h2>
              <button
                type="button"
                onClick={() => setActiveAtomId(null)}
                className="rounded p-1 hover:bg-zinc-800"
                aria-label="Close detail"
              >
                <X size={14} />
              </button>
            </div>
            {atomDetailQuery.isLoading && (
              <div className="opacity-70">Loading atom…</div>
            )}
            {atomDetailQuery.error && (
              <div className="text-red-400">Failed to load atom.</div>
            )}
            {atomDetailQuery.data && (
              <div className="flex flex-col gap-2">
                <div className="text-sm">
                  <div className="font-mono">
                    {atomDetailQuery.data.sectionNumber ?? "—"}
                  </div>
                  <div className="text-base">
                    {atomDetailQuery.data.sectionTitle ?? "(untitled)"}
                  </div>
                </div>
                <div className="font-mono text-xs opacity-70">
                  {atomDetailQuery.data.codeBook} ·{" "}
                  {atomDetailQuery.data.edition} ·{" "}
                  {atomDetailQuery.data.sourceName} · fetched{" "}
                  {relativeTime(atomDetailQuery.data.fetchedAt)}
                </div>
                <a
                  href={atomDetailQuery.data.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs underline"
                >
                  Open source <ExternalLink size={10} />
                </a>
                {atomDetailQuery.data.parentSection && (
                  <div className="text-xs opacity-70">
                    parent: {atomDetailQuery.data.parentSection}
                  </div>
                )}
                <div className="text-xs opacity-70">
                  embedding:{" "}
                  {atomDetailQuery.data.embedded
                    ? `yes (${atomDetailQuery.data.embeddingModel ?? "unknown model"})`
                    : "none"}
                </div>
                <pre
                  data-testid="atom-body"
                  className="whitespace-pre-wrap rounded bg-zinc-900 p-2 text-xs"
                >
                  {atomDetailQuery.data.body}
                </pre>
                <div className="font-mono text-[10px] opacity-50">
                  atom id: {atomDetailQuery.data.id}
                </div>
                {atomDetailQuery.data.metadata && (
                  <details className="text-xs opacity-80">
                    <summary className="cursor-pointer">metadata</summary>
                    <pre className="mt-1 whitespace-pre-wrap rounded bg-zinc-900 p-2 text-[11px]">
                      {JSON.stringify(atomDetailQuery.data.metadata, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          disabled={!hasPrev}
          onClick={() => changeOffset(-PAGE_SIZE)}
          className="rounded border border-zinc-600 px-3 py-1 disabled:opacity-40"
        >
          ← Prev
        </button>
        <button
          type="button"
          disabled={!hasNext}
          onClick={() => changeOffset(PAGE_SIZE)}
          className="rounded border border-zinc-600 px-3 py-1 disabled:opacity-40"
        >
          Next →
        </button>
        <span className="opacity-60">page size {PAGE_SIZE}</span>
      </div>
    </div>
  );
}

export default DevAtoms;
