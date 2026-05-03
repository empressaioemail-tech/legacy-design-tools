import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListCodeJurisdictions,
  useListCodeAtoms,
  useGetCodeAtom,
  useGetWarmupStatus,
  useWarmupJurisdiction,
  useBackfillCodeEmbeddings,
  getListCodeJurisdictionsQueryKey,
  getListCodeAtomsQueryKey,
  getGetWarmupStatusQueryKey,
  type JurisdictionSummary,
  type CodeAtomSummary,
  type WarmupStatus,
  type WarmupResult,
  type ListCodeAtomsParams,
} from "@workspace/api-client-react";
import { useNavGroups } from "../components/NavGroups";
import { useSessionAudience } from "../lib/session";
import { relativeTime } from "../lib/relativeTime";

const PAGE_SIZE = 50;

const STATE_PILL: Record<WarmupStatus["state"], string> = {
  idle: "sc-pill sc-pill-muted",
  running: "sc-pill sc-pill-cyan",
  completed: "sc-pill sc-pill-green",
  failed: "sc-pill sc-pill-red",
};

const STATE_LABEL: Record<WarmupStatus["state"], string> = {
  idle: "Idle",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

type Mode = "by-jurisdiction" | "all";

export default function CodeLibrary() {
  const navGroups = useNavGroups();
  const { audience } = useSessionAudience();
  const canManage = audience === "internal";

  const {
    data: jurisdictions,
    isLoading: jurisdictionsLoading,
    isError: jurisdictionsError,
  } = useListCodeJurisdictions();

  const list = jurisdictions ?? [];

  const [mode, setMode] = useState<Mode>("by-jurisdiction");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [initialOpenAtomId, setInitialOpenAtomId] = useState<string | null>(
    null,
  );
  const firstKey = list[0]?.key ?? null;
  useEffect(() => {
    if (selectedKey === null && firstKey) setSelectedKey(firstKey);
  }, [selectedKey, firstKey]);

  const selected = useMemo(
    () => list.find((j) => j.key === selectedKey) ?? null,
    [list, selectedKey],
  );

  const jurisdictionNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const j of list) map.set(j.key, j.displayName);
    return map;
  }, [list]);

  const handleOpenFromAll = (atom: CodeAtomSummary) => {
    setSelectedKey(atom.jurisdictionKey);
    setInitialOpenAtomId(atom.id);
    setMode("by-jurisdiction");
  };

  return (
    <DashboardLayout
      title="Code Library"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="flex flex-col gap-6" data-testid="code-library">
        <div>
          <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
            Code Library
          </h2>
          <div className="sc-body mt-1 sc-meta">
            Browse the municipal and building code atoms the AI Reviewer is
            grounded on, per jurisdiction.
          </div>
        </div>

        {jurisdictionsLoading ? (
          <div
            className="sc-card p-8 text-center sc-body"
            data-testid="code-library-loading"
          >
            Loading jurisdictions…
          </div>
        ) : jurisdictionsError ? (
          <div
            className="sc-card p-8 text-center sc-body text-[var(--danger)]"
            data-testid="code-library-error"
          >
            Couldn't load jurisdictions. Try refreshing the page.
          </div>
        ) : list.length === 0 ? (
          <div
            className="sc-card p-8 text-center sc-body"
            data-testid="code-library-empty"
          >
            No jurisdictions are configured.
          </div>
        ) : (
          <>
            <div
              className="flex items-center gap-2"
              data-testid="code-library-mode-tabs"
              role="tablist"
              aria-label="Code Library view"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "by-jurisdiction"}
                className={
                  mode === "by-jurisdiction" ? "sc-btn-primary" : "sc-btn-sm"
                }
                onClick={() => setMode("by-jurisdiction")}
                data-testid="code-library-mode-by-jurisdiction"
              >
                By jurisdiction
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "all"}
                className={mode === "all" ? "sc-btn-primary" : "sc-btn-sm"}
                onClick={() => setMode("all")}
                data-testid="code-library-mode-all"
              >
                Search all jurisdictions
              </button>
            </div>

            {mode === "by-jurisdiction" ? (
              <div className="grid gap-6 grid-cols-1 lg:grid-cols-[280px_1fr]">
                <JurisdictionList
                  jurisdictions={list}
                  selectedKey={selectedKey}
                  onSelect={setSelectedKey}
                />
                {selected ? (
                  <JurisdictionPane
                    jurisdiction={selected}
                    canManage={canManage}
                    initialOpenAtomId={initialOpenAtomId}
                    onConsumeInitialOpenAtomId={() =>
                      setInitialOpenAtomId(null)
                    }
                  />
                ) : (
                  <div className="sc-card p-8 text-center sc-body">
                    Pick a jurisdiction to browse its code atoms.
                  </div>
                )}
              </div>
            ) : (
              <AllJurisdictionsSearch
                jurisdictionNames={jurisdictionNames}
                onOpenAtom={handleOpenFromAll}
              />
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

function JurisdictionList({
  jurisdictions,
  selectedKey,
  onSelect,
}: {
  jurisdictions: ReadonlyArray<JurisdictionSummary>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="sc-card" data-testid="jurisdiction-list">
      <div className="sc-card-header">
        <span className="sc-label">JURISDICTIONS</span>
      </div>
      <div className="flex flex-col">
        {jurisdictions.map((j) => {
          const selected = j.key === selectedKey;
          return (
            <button
              type="button"
              key={j.key}
              onClick={() => onSelect(j.key)}
              data-testid={`jurisdiction-row-${j.key}`}
              aria-current={selected ? "true" : undefined}
              className="sc-card-row text-left"
              style={{
                background: selected ? "var(--surface-2)" : undefined,
                borderLeft: selected
                  ? "3px solid var(--accent)"
                  : "3px solid transparent",
              }}
            >
              <div className="flex flex-col w-full">
                <div className="sc-medium truncate">{j.displayName}</div>
                <div className="sc-mono-sm sc-meta mt-1">
                  {j.atomCount} atoms · {j.embeddedCount} embedded
                </div>
                <div className="sc-mono-sm sc-meta">
                  Last fetched {relativeTime(j.lastFetchedAt)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function JurisdictionPane({
  jurisdiction,
  canManage,
  initialOpenAtomId,
  onConsumeInitialOpenAtomId,
}: {
  jurisdiction: JurisdictionSummary;
  canManage: boolean;
  initialOpenAtomId?: string | null;
  onConsumeInitialOpenAtomId?: () => void;
}) {
  const [bookFilter, setBookFilter] = useState<string>("all");
  const [searchInput, setSearchInput] = useState<string>("");
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 250);
  const [page, setPage] = useState<number>(0);
  const [openAtomId, setOpenAtomId] = useState<string | null>(
    initialOpenAtomId ?? null,
  );

  // Reset state when jurisdiction or filters change so we don't surface a
  // stale page or codebook.
  useEffect(() => {
    setBookFilter("all");
    setSearchInput("");
    setPage(0);
    setOpenAtomId(initialOpenAtomId ?? null);
    if (initialOpenAtomId && onConsumeInitialOpenAtomId) {
      onConsumeInitialOpenAtomId();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jurisdiction.key]);

  // If a deep-link target arrives after the pane is already mounted on the
  // same jurisdiction, surface the modal too.
  useEffect(() => {
    if (initialOpenAtomId) {
      setOpenAtomId(initialOpenAtomId);
      onConsumeInitialOpenAtomId?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOpenAtomId]);

  useEffect(() => {
    setPage(0);
  }, [bookFilter, debouncedSearch]);

  const params: ListCodeAtomsParams = {
    jurisdictionKey: jurisdiction.key,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  if (bookFilter !== "all") params.codeBook = bookFilter;
  if (debouncedSearch) params.q = debouncedSearch;

  const {
    data: page_data,
    isLoading: atomsLoading,
    isError: atomsError,
    isFetching: atomsFetching,
  } = useListCodeAtoms(params);

  const items = page_data?.items ?? [];
  const total = page_data?.total ?? 0;
  const offset = page_data?.offset ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + items.length, total);
  const hasPrev = page > 0;
  const hasNext = offset + items.length < total;
  // Unfiltered jurisdiction-wide total comes from the jurisdictions
  // summary (cheap, already loaded). The "X of Y" header always
  // anchors on this so reviewers can see how big the corpus is even
  // while drilling in with a book pill or search query.
  const jurisdictionTotal = jurisdiction.atomCount;
  const isFiltered = bookFilter !== "all" || debouncedSearch.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <JurisdictionSummaryCard jurisdiction={jurisdiction} />

      <WarmupStatusPanel
        jurisdiction={jurisdiction}
        canManage={canManage}
      />

      <div className="sc-card" data-testid="atom-browser">
        <div className="sc-card-header sc-row-sb">
          <span className="sc-label">CODE ATOMS</span>
          <span className="sc-meta" data-testid="atom-browser-count">
            {atomsLoading
              ? "Loading…"
              : isFiltered
                ? total === 0
                  ? `0 of ${jurisdictionTotal} (0 matches)`
                  : `${pageStart}–${pageEnd} of ${jurisdictionTotal} (${total} match${total === 1 ? "" : "es"})`
                : total === 0
                  ? `0 of ${jurisdictionTotal}`
                  : `${pageStart}–${pageEnd} of ${jurisdictionTotal}`}
          </span>
        </div>

        <div
          className="flex flex-col gap-3 p-3"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => setBookFilter("all")}
              className={
                bookFilter === "all" ? "sc-btn-primary" : "sc-btn-sm"
              }
              data-testid="atom-book-filter-all"
            >
              All books
            </button>
            {jurisdiction.books.map((b) => (
              <button
                type="button"
                key={`${b.codeBook}|${b.edition}`}
                onClick={() => setBookFilter(b.codeBook)}
                className={
                  bookFilter === b.codeBook ? "sc-btn-primary" : "sc-btn-sm"
                }
                data-testid={`atom-book-filter-${b.codeBook}`}
                title={`${b.label} (${b.edition})`}
              >
                {b.label}
                <span className="sc-meta ml-2">{b.atomCount}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search section number or title…"
            data-testid="atom-search-input"
            aria-label="Search code atoms"
            className="sc-input"
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "var(--surface-1)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-primary)",
            }}
          />
        </div>

        <div className="flex flex-col" data-testid="atom-list">
          {atomsLoading ? (
            <div
              className="p-8 text-center sc-body"
              data-testid="atom-list-loading"
            >
              Loading atoms…
            </div>
          ) : atomsError ? (
            <div
              className="p-8 text-center sc-body text-[var(--danger)]"
              data-testid="atom-list-error"
            >
              Couldn't load atoms.
            </div>
          ) : items.length === 0 ? (
            <div
              className="p-8 text-center sc-body"
              data-testid="atom-list-empty"
            >
              {debouncedSearch
                ? "No atoms match your search."
                : "No atoms ingested yet for this jurisdiction."}
            </div>
          ) : (
            items.map((atom) => (
              <AtomRow
                key={atom.id}
                atom={atom}
                onOpen={() => setOpenAtomId(atom.id)}
              />
            ))
          )}
        </div>

        {total > PAGE_SIZE ? (
          <div
            className="flex items-center justify-between p-3"
            style={{ borderTop: "1px solid var(--border)" }}
            data-testid="atom-pagination"
          >
            <button
              type="button"
              className="sc-btn-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={!hasPrev || atomsFetching}
              data-testid="atom-pagination-prev"
            >
              ← Previous
            </button>
            <span className="sc-mono-sm sc-meta">
              Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
            </span>
            <button
              type="button"
              className="sc-btn-sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext || atomsFetching}
              data-testid="atom-pagination-next"
            >
              Next →
            </button>
          </div>
        ) : null}
      </div>

      {openAtomId ? (
        <AtomDetailModal
          atomId={openAtomId}
          onClose={() => setOpenAtomId(null)}
        />
      ) : null}
    </div>
  );
}

function AllJurisdictionsSearch({
  jurisdictionNames,
  onOpenAtom,
}: {
  jurisdictionNames: Map<string, string>;
  onOpenAtom: (atom: CodeAtomSummary) => void;
}) {
  const [searchInput, setSearchInput] = useState<string>("");
  const debouncedSearch = useDebouncedValue(searchInput.trim(), 250);
  const [page, setPage] = useState<number>(0);

  useEffect(() => {
    setPage(0);
  }, [debouncedSearch]);

  const params: ListCodeAtomsParams = {
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  if (debouncedSearch) params.q = debouncedSearch;

  const {
    data: page_data,
    isLoading,
    isError,
    isFetching,
  } = useListCodeAtoms(params);

  const items = page_data?.items ?? [];
  const total = page_data?.total ?? 0;
  const offset = page_data?.offset ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + items.length, total);
  const hasPrev = page > 0;
  const hasNext = offset + items.length < total;

  return (
    <div className="sc-card" data-testid="atom-browser-all">
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">CODE ATOMS · ALL JURISDICTIONS</span>
        <span className="sc-meta" data-testid="atom-browser-all-count">
          {isLoading
            ? "Loading…"
            : total === 0
              ? "0 results"
              : `${pageStart}–${pageEnd} of ${total}`}
        </span>
      </div>

      <div
        className="flex flex-col gap-3 p-3"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search section number or title across every jurisdiction…"
          data-testid="atom-search-input-all"
          aria-label="Search code atoms across all jurisdictions"
          className="sc-input"
          style={{
            width: "100%",
            padding: "8px 10px",
            background: "var(--surface-1)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-primary)",
          }}
        />
      </div>

      <div className="flex flex-col" data-testid="atom-list-all">
        {isLoading ? (
          <div
            className="p-8 text-center sc-body"
            data-testid="atom-list-all-loading"
          >
            Loading atoms…
          </div>
        ) : isError ? (
          <div
            className="p-8 text-center sc-body text-[var(--danger)]"
            data-testid="atom-list-all-error"
          >
            Couldn't load atoms.
          </div>
        ) : items.length === 0 ? (
          <div
            className="p-8 text-center sc-body"
            data-testid="atom-list-all-empty"
          >
            {debouncedSearch
              ? "No atoms match your search."
              : "Type to search across every ingested jurisdiction."}
          </div>
        ) : (
          items.map((atom) => (
            <AtomRow
              key={atom.id}
              atom={atom}
              jurisdictionLabel={
                jurisdictionNames.get(atom.jurisdictionKey) ??
                atom.jurisdictionKey
              }
              onOpen={() => onOpenAtom(atom)}
            />
          ))
        )}
      </div>

      {total > PAGE_SIZE ? (
        <div
          className="flex items-center justify-between p-3"
          style={{ borderTop: "1px solid var(--border)" }}
          data-testid="atom-pagination-all"
        >
          <button
            type="button"
            className="sc-btn-sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={!hasPrev || isFetching}
            data-testid="atom-pagination-all-prev"
          >
            ← Previous
          </button>
          <span className="sc-mono-sm sc-meta">
            Page {page + 1} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
          </span>
          <button
            type="button"
            className="sc-btn-sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasNext || isFetching}
            data-testid="atom-pagination-all-next"
          >
            Next →
          </button>
        </div>
      ) : null}
    </div>
  );
}

function JurisdictionSummaryCard({
  jurisdiction,
}: {
  jurisdiction: JurisdictionSummary;
}) {
  return (
    <div className="sc-card p-4" data-testid="jurisdiction-summary">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <div className="sc-label">JURISDICTION</div>
          <h3 className="text-[18px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0 mt-1">
            {jurisdiction.displayName}
          </h3>
        </div>
        <div className="sc-mono-sm sc-meta">
          {jurisdiction.atomCount} atoms · {jurisdiction.embeddedCount}{" "}
          embedded · last fetched {relativeTime(jurisdiction.lastFetchedAt)}
        </div>
      </div>
      {jurisdiction.books.length > 0 ? (
        <div className="flex items-center gap-2 flex-wrap mt-3">
          {jurisdiction.books.map((b) => (
            <span
              key={`${b.codeBook}|${b.edition}`}
              className="sc-pill sc-pill-muted"
              data-testid={`jurisdiction-book-${b.codeBook}`}
              title={`${b.codeBook} ${b.edition} · ${b.sourceName}`}
            >
              {b.label} · {b.edition}
              <span className="sc-meta ml-2">{b.atomCount}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WarmupStatusPanel({
  jurisdiction,
  canManage,
}: {
  jurisdiction: JurisdictionSummary;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const jurisdictionKey = jurisdiction.key;
  const [warmupError, setWarmupError] = useState<string | null>(null);
  const [lastWarmupResult, setLastWarmupResult] =
    useState<WarmupResult | null>(null);
  const [lastBackfillMessage, setLastBackfillMessage] = useState<string | null>(
    null,
  );

  const missingEmbeddings = Math.max(
    0,
    jurisdiction.atomCount - jurisdiction.embeddedCount,
  );

  const { data: status } = useGetWarmupStatus(jurisdictionKey, {
    query: {
      queryKey: getGetWarmupStatusQueryKey(jurisdictionKey),
      refetchInterval: (query) => {
        const data = query.state.data as WarmupStatus | undefined;
        return data?.state === "running" ? 3000 : false;
      },
    },
  });

  const invalidateAtomLists = async () => {
    await queryClient.invalidateQueries({
      queryKey: getListCodeAtomsQueryKey({ jurisdictionKey }),
    });
  };

  const warmup = useWarmupJurisdiction({
    mutation: {
      onSuccess: async (result) => {
        setWarmupError(null);
        setLastWarmupResult(result);
        await queryClient.invalidateQueries({
          queryKey: getGetWarmupStatusQueryKey(jurisdictionKey),
        });
        await queryClient.invalidateQueries({
          queryKey: getListCodeJurisdictionsQueryKey(),
        });
        await invalidateAtomLists();
      },
      onError: (err) => {
        setWarmupError(
          err instanceof Error ? err.message : "Warmup failed — try again.",
        );
      },
    },
  });

  const backfill = useBackfillCodeEmbeddings({
    mutation: {
      onSuccess: async (result) => {
        setLastBackfillMessage(
          `Embedded ${result.embedded} of ${result.scanned} scanned (${result.remaining} still pending).`,
        );
        await queryClient.invalidateQueries({
          queryKey: getListCodeJurisdictionsQueryKey(),
        });
        await invalidateAtomLists();
      },
      onError: (err) => {
        setLastBackfillMessage(
          err instanceof Error
            ? err.message
            : "Backfill failed — try again.",
        );
      },
    },
  });

  const state = status?.state ?? "idle";
  const discoveryErrors = lastWarmupResult?.discoveryErrors ?? [];
  const embedDisabled =
    backfill.isPending || (missingEmbeddings === 0 && !backfill.isPending);

  return (
    <div className="sc-card p-4" data-testid="warmup-panel">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="sc-label">INGESTION</span>
          <span
            className={STATE_PILL[state]}
            data-testid="warmup-state-pill"
          >
            {STATE_LABEL[state]}
          </span>
        </div>
        {canManage ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => warmup.mutate({ key: jurisdictionKey })}
              disabled={warmup.isPending || state === "running"}
              className="sc-btn-sm"
              data-testid="warmup-button"
            >
              {warmup.isPending
                ? "Warming up…"
                : state === "running"
                  ? "Warmup in progress"
                  : "Warm up now"}
            </button>
            <button
              type="button"
              onClick={() => backfill.mutate({})}
              disabled={embedDisabled}
              className="sc-btn-sm"
              data-testid="embed-backfill-button"
              title={
                missingEmbeddings === 0
                  ? "Every atom in this jurisdiction already has an embedding."
                  : `Embed ${missingEmbeddings} atom${missingEmbeddings === 1 ? "" : "s"} still missing a vector.`
              }
            >
              {backfill.isPending
                ? "Embedding…"
                : missingEmbeddings === 0
                  ? "All atoms embedded"
                  : `Embed ${missingEmbeddings} missing atom${missingEmbeddings === 1 ? "" : "s"}`}
            </button>
          </div>
        ) : null}
      </div>

      {status ? (
        <div
          className="sc-mono-sm sc-meta mt-3 flex flex-wrap gap-4"
          data-testid="warmup-counts"
        >
          <span>pending: {status.pending}</span>
          <span>processing: {status.processing}</span>
          <span>completed: {status.completed}</span>
          <span>failed: {status.failed}</span>
        </div>
      ) : null}

      {status ? (
        <div className="sc-mono-sm sc-meta mt-1 flex flex-wrap gap-4">
          <span>started: {formatTimestamp(status.startedAt)}</span>
          <span>completed: {formatTimestamp(status.completedAt)}</span>
        </div>
      ) : null}

      {status?.lastError ? (
        <div
          className="sc-body mt-3"
          style={{ color: "var(--danger)" }}
          data-testid="warmup-last-error"
          role="alert"
        >
          Last error: {status.lastError}
        </div>
      ) : null}

      {warmupError ? (
        <div
          className="sc-body mt-3"
          style={{ color: "var(--danger)" }}
          data-testid="warmup-call-error"
          role="alert"
        >
          {warmupError}
        </div>
      ) : null}

      {discoveryErrors.length > 0 ? (
        <div
          className="sc-body mt-3"
          style={{ color: "var(--danger)" }}
          data-testid="warmup-discovery-errors"
          role="alert"
        >
          <div className="sc-medium">Discovery errors:</div>
          <ul className="mt-1 ml-4 list-disc">
            {discoveryErrors.map((d, i) => (
              <li key={`${d.sourceName}-${i}`}>
                <span className="sc-mono-sm">{d.sourceName}</span>: {d.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {lastBackfillMessage ? (
        <div
          className="sc-body mt-3 sc-meta"
          data-testid="embed-backfill-result"
        >
          {lastBackfillMessage}
        </div>
      ) : null}
    </div>
  );
}

function AtomRow({
  atom,
  onOpen,
  jurisdictionLabel,
}: {
  atom: CodeAtomSummary;
  onOpen: () => void;
  jurisdictionLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="sc-card-row text-left w-full"
      data-testid={`atom-row-${atom.id}`}
    >
      <div className="flex flex-col w-full min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className="sc-mono-sm sc-medium shrink-0">
            {atom.sectionNumber ?? "—"}
          </span>
          <span className="sc-medium truncate">
            {atom.sectionTitle ?? "(untitled)"}
          </span>
          {jurisdictionLabel ? (
            <span
              className="sc-pill sc-pill-cyan shrink-0"
              data-testid={`atom-row-${atom.id}-jurisdiction`}
              title={`Jurisdiction: ${jurisdictionLabel}`}
            >
              {jurisdictionLabel}
            </span>
          ) : null}
          {!atom.embedded ? (
            <span
              className="sc-pill sc-pill-amber shrink-0"
              title="No embedding vector yet"
            >
              Not embedded
            </span>
          ) : null}
        </div>
        <div className="sc-mono-sm sc-meta mt-1">
          {atom.codeBook} · {atom.edition} · {atom.sourceName}
        </div>
        <div className="sc-body sc-meta mt-1 line-clamp-2">
          {atom.bodyPreview}
        </div>
      </div>
    </button>
  );
}

function SanitizedHtml({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    // Code-source HTML is fetched from external municipal pages; sanitize
    // before injecting so a hostile upstream cannot script the reviewer's
    // session. DOMPurify defaults strip <script>, on* handlers, and
    // javascript: URLs.
    ref.current.innerHTML = DOMPurify.sanitize(html);
  }, [html]);
  return <div ref={ref} />;
}

function AtomDetailModal({
  atomId,
  onClose,
}: {
  atomId: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useGetCodeAtom(atomId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Code atom detail"
      data-testid="atom-detail-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 100,
      }}
    >
      <div
        className="sc-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 780,
          width: "100%",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="sc-card-header sc-row-sb">
          <span className="sc-label">CODE ATOM</span>
          <button
            type="button"
            onClick={onClose}
            className="sc-btn-sm"
            data-testid="atom-detail-close"
            aria-label="Close atom detail"
          >
            Close
          </button>
        </div>
        <div
          style={{ overflowY: "auto", padding: 16 }}
          data-testid="atom-detail-body"
        >
          {isLoading ? (
            <div className="sc-body" data-testid="atom-detail-loading">
              Loading atom…
            </div>
          ) : isError || !data ? (
            <div
              className="sc-body text-[var(--danger)]"
              data-testid="atom-detail-error"
            >
              Couldn't load this atom.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <div className="sc-mono-sm sc-medium">
                  {data.sectionNumber ?? "—"}
                </div>
                <h3 className="text-[18px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0 mt-1">
                  {data.sectionTitle ?? "(untitled)"}
                </h3>
                <div className="sc-mono-sm sc-meta mt-1">
                  {data.codeBook} · {data.edition} · {data.sourceName}
                </div>
                {data.parentSection ? (
                  <div className="sc-mono-sm sc-meta mt-1">
                    Parent section: {data.parentSection}
                  </div>
                ) : null}
                <div className="sc-mono-sm sc-meta mt-1">
                  Embedding:{" "}
                  {data.embeddingModel
                    ? data.embeddingModel
                    : data.embedded
                      ? "yes"
                      : "not embedded"}
                </div>
                <div className="sc-mono-sm sc-meta mt-1">
                  Fetched: {formatTimestamp(data.fetchedAt)}
                </div>
                {data.sourceUrl ? (
                  <div className="mt-2">
                    <a
                      className="sc-link sc-mono-sm"
                      href={data.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-testid="atom-detail-source-link"
                    >
                      Open source ↗
                    </a>
                  </div>
                ) : null}
              </div>

              <div className="sc-prose" data-testid="atom-detail-content">
                {data.bodyHtml ? (
                  <SanitizedHtml html={data.bodyHtml} />
                ) : (
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      fontFamily: "inherit",
                      margin: 0,
                    }}
                  >
                    {data.body}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
