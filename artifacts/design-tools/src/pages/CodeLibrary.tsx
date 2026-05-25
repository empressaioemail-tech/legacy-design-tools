import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListCodeJurisdictions,
  useListJurisdictionAtoms,
  useGetCodeAtom,
  useListEngagements,
  useGetEngagement,
  warmupJurisdiction,
  getWarmupStatus,
  getListCodeJurisdictionsQueryKey,
  getListJurisdictionAtomsQueryKey,
  getGetCodeAtomQueryKey,
  type JurisdictionSummary,
  type WarmupStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, ExternalLink, X } from "lucide-react";
import { Link } from "wouter";
import { SubstrateCatalogPanel } from "../components/SubstrateCatalogPanel";
import {
  JurisdictionCard,
  type ActiveBook,
} from "../components/code-library/JurisdictionCard";
import {
  collectRelevantStateCodes,
  filterJurisdictionsBySearch,
  filterJurisdictionsByStates,
  jurisdictionMatchesState,
  normalizeStateCode,
} from "../lib/jurisdictionSurfacing";
import { fetchWorkspaceSettings } from "../lib/workspaceSettingsApi";

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

function readAtomFromHash(): string | null {
  const m = window.location.search.match(/[?&]atom=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function readEngagementIdFromSearch(): string | null {
  const m = window.location.search.match(/[?&]engagementId=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TICKS = 90; // ~3 minutes
const ERROR_AUTOCLEAR_MS = 5000;
// Tolerate transient network blips before declaring polling broken. Three
// consecutive failures (~6s) is short enough to surface real outages without
// flapping on a single dropped request.
const POLL_FAILURE_THRESHOLD = 3;

export function CodeLibrary({ embedded = false }: { embedded?: boolean }) {
  const [substrateSource, setSubstrateSource] = useState<"mcp" | "mock" | null>(
    null,
  );
  const [substrateShowAll, setSubstrateShowAll] = useState(false);
  const [practiceStates, setPracticeStates] = useState<string[]>([]);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [exploreSearch, setExploreSearch] = useState("");
  const contextEngagementId = readEngagementIdFromSearch();
  const qc = useQueryClient();
  const { data: engagements } = useListEngagements({
    query: { queryKey: ["engagements"], enabled: true },
  });
  const { data: contextEngagement } = useGetEngagement(contextEngagementId ?? "", {
    query: {
      queryKey: ["engagement", contextEngagementId ?? ""],
      enabled: !!contextEngagementId,
    },
  });
  useEffect(() => {
    void fetchWorkspaceSettings()
      .then((s) => setPracticeStates(s.practiceStates ?? []))
      .catch(() => {
        /* defaults */
      });
  }, []);
  const { data: jurisdictions, isLoading } = useListCodeJurisdictions({
    query: {
      queryKey: getListCodeJurisdictionsQueryKey(),
      refetchInterval: 5000,
    },
  });

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeBook, setActiveBook] = useState<ActiveBook | null>(null);
  const [activeAtomId, setActiveAtomId] = useState<string | null>(() =>
    readAtomFromHash(),
  );
  const [warming, setWarming] = useState<Record<string, boolean>>({});
  const [warmupMsg, setWarmupMsg] = useState<Record<string, string>>({});
  const [warmupStatusMap, setWarmupStatusMap] = useState<
    Record<string, WarmupStatus>
  >({});
  // Per-jurisdiction monotonic run id. Each click increments. Auto-clear
  // timeouts capture the run id at schedule time and only fire if the
  // stored id matches — a fast retry then can't have its message wiped by
  // a stale timer from the previous run.
  const warmupRunIdRef = useRef<Record<string, number>>({});

  const relevantStates = useMemo(
    () =>
      collectRelevantStateCodes(engagements ?? [], practiceStates),
    [engagements, practiceStates],
  );

  const contextState = useMemo(() => {
    const geo = contextEngagement?.site?.geocode;
    return normalizeStateCode(geo?.jurisdictionState ?? null);
  }, [contextEngagement]);

  const coverageByEngagementState = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of engagements ?? []) {
      const st = normalizeStateCode(e.site?.geocode?.jurisdictionState);
      const cov = (e as { coverageStatus?: string }).coverageStatus;
      if (st && cov) m.set(st, cov);
    }
    if (contextEngagement) {
      const cov = (contextEngagement as { coverageStatus?: string })
        .coverageStatus;
      if (contextState && cov) m.set(contextState, cov);
    }
    return m;
  }, [engagements, contextEngagement, contextState]);

  const { firmJurisdictions, activeJurisdictions, exploreJurisdictions } =
    useMemo(() => {
      const all = jurisdictions ?? [];
      const searched = filterJurisdictionsBySearch(all, exploreSearch);
      const firm = filterJurisdictionsByStates(searched, relevantStates);
      const active =
        contextState != null
          ? firm.filter((j) => jurisdictionMatchesState(j, contextState))
          : [];
      const firmRest =
        active.length > 0
          ? firm.filter(
              (j) =>
                !active.some((a) => a.key === j.key),
            )
          : firm;
      return {
        firmJurisdictions: firmRest,
        activeJurisdictions: active,
        exploreJurisdictions: searched,
      };
    }, [jurisdictions, relevantStates, contextState, exploreSearch]);

  const hasFirmScope = relevantStates.size > 0;
  const engagementCount = engagements?.length ?? 0;

  // Default selection: first card in Your firm (or active project).
  useEffect(() => {
    if (activeKey) return;
    const pick =
      activeJurisdictions[0]?.key ??
      firmJurisdictions[0]?.key ??
      null;
    if (pick) setActiveKey(pick);
  }, [activeKey, activeJurisdictions, firmJurisdictions]);

  // If URL has ?atom=<id>, fetch the atom, then jump to its jurisdiction.
  const atomDetailQuery = useGetCodeAtom(activeAtomId ?? "", {
    query: {
      enabled: !!activeAtomId,
      queryKey: activeAtomId
        ? getGetCodeAtomQueryKey(activeAtomId)
        : ["codes", "atom", "none"],
    },
  });
  useEffect(() => {
    if (atomDetailQuery.data && atomDetailQuery.data.jurisdictionKey) {
      setActiveKey(atomDetailQuery.data.jurisdictionKey);
    }
  }, [atomDetailQuery.data]);

  // Atom list — server-filters by codeBook+edition when a book pill is active.
  const atomQueryParams = useMemo(
    () => ({
      limit: 100,
      ...(activeBook && activeBook.jurisdictionKey === activeKey
        ? { codeBook: activeBook.codeBook, edition: activeBook.edition }
        : {}),
    }),
    [activeBook, activeKey],
  );
  const atomsQuery = useListJurisdictionAtoms(
    activeKey ?? "",
    atomQueryParams,
    {
      query: {
        enabled: !!activeKey,
        queryKey: activeKey
          ? getListJurisdictionAtomsQueryKey(activeKey, atomQueryParams)
          : ["codes", "atoms", "none"],
        refetchInterval: 5000,
      },
    },
  );

  const handleWarmup = async (key: string) => {
    // Bump the run id and capture the value for auto-clear-scope checks below.
    const runId = (warmupRunIdRef.current[key] ?? 0) + 1;
    warmupRunIdRef.current[key] = runId;
    const scheduleAutoClear = (ms: number) => {
      setTimeout(() => {
        if (warmupRunIdRef.current[key] === runId) {
          setWarmupMsg((m) => ({ ...m, [key]: "" }));
        }
      }, ms);
    };

    setWarming((w) => ({ ...w, [key]: true }));
    setWarmupMsg((m) => ({ ...m, [key]: "" }));
    setWarmupStatusMap((s) => ({
      ...s,
      [key]: {
        ...s[key],
        jurisdictionKey: key,
        state: "running",
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        total: 0,
        startedAt: null,
        completedAt: null,
        lastError: null,
      },
    }));
    try {
      const warmupRes = await warmupJurisdiction(key);
      // Discovery-phase failures must not be silent. If the orchestrator
      // couldn't enqueue anything (missing source row, listToc threw, etc),
      // surface the first error inline so the user can act without logs.
      const discoveryErrors = (warmupRes as { discoveryErrors?: Array<{ sourceName: string; error: string }> }).discoveryErrors ?? [];
      if (discoveryErrors.length > 0 && warmupRes.enqueued === 0) {
        const first = discoveryErrors[0];
        setWarmupMsg((m) => ({
          ...m,
          [key]: `Warmup discovered nothing — ${first.sourceName}: ${first.error}`,
        }));
        scheduleAutoClear(ERROR_AUTOCLEAR_MS * 2);
        return;
      }

      // Poll every POLL_INTERVAL_MS until the queue reports a terminal state.
      // Bound by POLL_MAX_TICKS so a stuck queue doesn't hold the spinner
      // forever. Track consecutive polling failures so an unreachable status
      // endpoint can't silently terminate the loop.
      let lastStatus: WarmupStatus | null = null;
      let pollFailures = 0;
      let pollUnreachable = false;
      for (let i = 0; i < POLL_MAX_TICKS; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        try {
          const status = await getWarmupStatus(key);
          lastStatus = status;
          pollFailures = 0;
          setWarmupStatusMap((s) => ({ ...s, [key]: status }));
          if (status.state !== "running") break;
        } catch {
          // Tolerate transient blips, but don't hide a sustained outage.
          pollFailures++;
          if (pollFailures >= POLL_FAILURE_THRESHOLD) {
            pollUnreachable = true;
            break;
          }
        }
      }
      // Refresh counts now that the queue settled.
      void qc.invalidateQueries({
        queryKey: getListCodeJurisdictionsQueryKey(),
      });
      if (activeKey) {
        void qc.invalidateQueries({
          queryKey: getListJurisdictionAtomsQueryKey(activeKey, atomQueryParams),
        });
      }
      // Outcome message.
      if (pollUnreachable) {
        setWarmupMsg((m) => ({
          ...m,
          [key]: "Status polling unavailable — backend may be unreachable. Refresh to recheck.",
        }));
        scheduleAutoClear(ERROR_AUTOCLEAR_MS * 2);
      } else if (lastStatus && lastStatus.state === "failed") {
        const detail = lastStatus.lastError ? `: ${lastStatus.lastError}` : "";
        setWarmupMsg((m) => ({
          ...m,
          [key]: `Warmup failed (${lastStatus!.failed}/${lastStatus!.total} sections)${detail}`,
        }));
        scheduleAutoClear(ERROR_AUTOCLEAR_MS);
      } else if (lastStatus && lastStatus.state === "completed") {
        setWarmupMsg((m) => ({
          ...m,
          [key]: `Completed ${lastStatus!.completed}/${lastStatus!.total} sections.`,
        }));
      } else if (lastStatus && lastStatus.state === "idle") {
        // Polled long enough to see "idle" — discovery + drain produced
        // nothing, but no per-book error was reported either. Still better
        // to say so than to leave the card blank.
        setWarmupMsg((m) => ({
          ...m,
          [key]: "Warmup found nothing to process. Check that this jurisdiction's sources are configured.",
        }));
        scheduleAutoClear(ERROR_AUTOCLEAR_MS * 2);
      } else if (lastStatus && lastStatus.state === "running") {
        setWarmupMsg((m) => ({
          ...m,
          [key]: `Still running in background (${lastStatus!.completed}/${lastStatus!.total} done)`,
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setWarmupMsg((m) => ({ ...m, [key]: `Warmup failed: ${msg}` }));
      scheduleAutoClear(ERROR_AUTOCLEAR_MS);
    } finally {
      setWarming((w) => ({ ...w, [key]: false }));
    }
  };

  const activeJurisdiction = useMemo<JurisdictionSummary | undefined>(
    () => jurisdictions?.find((j) => j.key === activeKey),
    [jurisdictions, activeKey],
  );

  return (
    <div
      className={
        embedded
          ? "cockpit-dashboard-code-embedded flex flex-col gap-6"
          : "p-6 max-w-7xl mx-auto flex flex-col gap-6"
      }
      data-testid={embedded ? "dashboard-code-library" : "code-library-page"}
    >
      {!embedded && (
        <>
          <div className="flex items-center gap-2">
            <BookOpen size={20} />
            <h1 className="text-2xl">Code Library</h1>
          </div>
          <p className="sc-body opacity-70">
            Atom-anchored code knowledge. Atoms are fetched on demand the first
            time an engagement geocodes to a configured jurisdiction. Click a
            card to browse its atoms, click a book pill to filter, or open one
            to see the full text and source link.
          </p>
        </>
      )}

      {/* QA-17 — every jurisdiction in the Hauska substrate, read live via
          the MCP catalog surface. Sits above the cortex-prod-local corpus
          (which still owns warmup + atom browsing). */}
      <SubstrateCatalogPanel
        onSourceChange={setSubstrateSource}
        stateCodes={[...relevantStates]}
        showAllJurisdictions={substrateShowAll}
        onShowAllChange={setSubstrateShowAll}
      />

      {substrateSource !== "mcp" && (
        <h2 className="sc-label" style={{ marginTop: 8 }}>
          Cortex-local corpus
        </h2>
      )}
      {substrateSource === "mcp" && (
        <p className="sc-meta opacity-70" data-testid="code-library-mcp-unified">
          Live substrate catalog — browse atoms below for jurisdictions with a
          warmed cortex-local corpus.
        </p>
      )}

      {isLoading && <div className="sc-body">Loading jurisdictions…</div>}

      {contextEngagementId && (
        <section data-testid="code-library-section-active-project">
          <h2 className="sc-label">Active on this project</h2>
          {activeJurisdictions.length === 0 ? (
            <p className="sc-meta opacity-70">
              No code corpus matched — add or correct the address on the Site
              tab.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
              {activeJurisdictions.map((j) => (
                <JurisdictionCard
                  key={j.key}
                  section="active"
                  j={j}
                  isActive={j.key === activeKey}
                  activeBook={activeBook}
                  liveStatus={warmupStatusMap[j.key]}
                  isWarming={!!warming[j.key]}
                  warmupMsg={warmupMsg[j.key] ?? ""}
                  coverageStatus={
                    contextState
                      ? coverageByEngagementState.get(contextState)
                      : undefined
                  }
                  onSelect={() => {
                    setActiveKey(j.key);
                    if (activeBook && activeBook.jurisdictionKey !== j.key) {
                      setActiveBook(null);
                    }
                  }}
                  onWarmup={(e) => {
                    e.stopPropagation();
                    void handleWarmup(j.key);
                  }}
                  onSelectBook={(book, e) => {
                    e.stopPropagation();
                    setActiveKey(j.key);
                    setActiveBook(book);
                    setActiveAtomId(null);
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}

      <section data-testid="code-library-section-your-firm">
        <h2 className="sc-label">Your firm</h2>
        {!hasFirmScope && engagementCount === 0 ? (
          <p className="sc-meta opacity-70" data-testid="code-library-firm-empty">
            Set practice states in{" "}
            <Link href="/workspace" className="underline" style={{ color: "var(--cyan)" }}>
              Workspace settings
            </Link>{" "}
            or create a project to see relevant jurisdictions here. Expand
            Explore catalog for the full list.
          </p>
        ) : firmJurisdictions.length === 0 ? (
          <p className="sc-meta opacity-70">
            No cortex-local jurisdictions match your states yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-2">
            {firmJurisdictions.map((j) => {
              const st = [...relevantStates].find((s) =>
                jurisdictionMatchesState(j, s),
              );
              return (
                <JurisdictionCard
                  key={j.key}
                  section="firm"
                  j={j}
                  isActive={j.key === activeKey}
                  activeBook={activeBook}
                  liveStatus={warmupStatusMap[j.key]}
                  isWarming={!!warming[j.key]}
                  warmupMsg={warmupMsg[j.key] ?? ""}
                  coverageStatus={st ? coverageByEngagementState.get(st) : undefined}
                  onSelect={() => {
                    setActiveKey(j.key);
                    if (activeBook && activeBook.jurisdictionKey !== j.key) {
                      setActiveBook(null);
                    }
                  }}
                  onWarmup={(e) => {
                    e.stopPropagation();
                    void handleWarmup(j.key);
                  }}
                  onSelectBook={(book, e) => {
                    e.stopPropagation();
                    setActiveKey(j.key);
                    setActiveBook(book);
                    setActiveAtomId(null);
                  }}
                />
              );
            })}
          </div>
        )}
      </section>

      <details
        open={exploreOpen}
        onToggle={(e) => setExploreOpen((e.target as HTMLDetailsElement).open)}
        data-testid="code-library-section-explore"
        className="mt-2"
      >
        <summary className="sc-label cursor-pointer">Explore catalog</summary>
        <div className="mt-3 flex flex-col gap-3">
          <input
            type="search"
            className="sc-input max-w-md"
            placeholder="Search jurisdictions…"
            value={exploreSearch}
            onChange={(e) => setExploreSearch(e.target.value)}
            data-testid="code-library-explore-search"
          />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {exploreJurisdictions.map((j) => (
              <JurisdictionCard
                key={j.key}
                section="explore"
                j={j}
                isActive={j.key === activeKey}
                activeBook={activeBook}
                liveStatus={warmupStatusMap[j.key]}
                isWarming={!!warming[j.key]}
                warmupMsg={warmupMsg[j.key] ?? ""}
                onSelect={() => {
                  setActiveKey(j.key);
                  if (activeBook && activeBook.jurisdictionKey !== j.key) {
                    setActiveBook(null);
                  }
                }}
                onWarmup={(e) => {
                  e.stopPropagation();
                  void handleWarmup(j.key);
                }}
                onSelectBook={(book, e) => {
                  e.stopPropagation();
                  setActiveKey(j.key);
                  setActiveBook(book);
                  setActiveAtomId(null);
                }}
              />
            ))}
          </div>
        </div>
      </details>

      {activeKey && activeJurisdiction && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
          <div className="sc-card p-3 flex flex-col" style={{ minHeight: 400 }}>
            <div className="sc-card-header flex items-center justify-between">
              <span className="sc-label">
                {activeJurisdiction.displayName} ·{" "}
                {activeBook ? activeBook.label : "All books"}
              </span>
              <span className="sc-meta opacity-60">
                {atomsQuery.data?.length ?? 0}
              </span>
            </div>
            {activeBook && activeBook.jurisdictionKey === activeKey && (
              <button
                type="button"
                onClick={() => setActiveBook(null)}
                className="sc-meta inline-flex items-center gap-1 mt-1 self-start"
                data-testid="clear-book-filter"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--cyan)",
                  cursor: "pointer",
                }}
              >
                <X size={11} /> Clear book filter
              </button>
            )}
            <div
              className="flex-1 overflow-y-auto sc-scroll mt-2 flex flex-col gap-1"
              style={{ maxHeight: 600 }}
            >
              {atomsQuery.isLoading && (
                <div className="sc-body opacity-60 p-2">Loading…</div>
              )}
              {!atomsQuery.isLoading &&
                (atomsQuery.data?.length ?? 0) === 0 && (
                  <div className="sc-body opacity-60 p-2">
                    {activeBook
                      ? "No atoms for this book yet."
                      : "No atoms yet. Try “Warm up now”."}
                  </div>
                )}
              {(atomsQuery.data ?? []).map((a) => {
                const isAtomActive = a.id === activeAtomId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-testid={`atom-row-${a.id}`}
                    onClick={() => setActiveAtomId(a.id)}
                    className="sc-ui text-left"
                    style={{
                      background: isAtomActive
                        ? "rgba(0,180,216,0.10)"
                        : "transparent",
                      border: "1px solid",
                      borderColor: isAtomActive
                        ? "var(--cyan)"
                        : "var(--border-default)",
                      borderRadius: 4,
                      padding: "8px 10px",
                      cursor: "pointer",
                    }}
                  >
                    <div className="flex justify-between gap-2">
                      <span className="sc-medium">
                        {a.sectionNumber ?? "—"}{" "}
                        <span className="opacity-70">
                          {a.sectionTitle ?? ""}
                        </span>
                      </span>
                      <span className="sc-meta opacity-60">
                        {a.embedded ? "vec" : "raw"}
                      </span>
                    </div>
                    <div className="sc-meta opacity-60 mt-1">
                      {a.codeBook} · {a.edition} · {a.sourceName}
                    </div>
                    <div className="sc-meta opacity-50 mt-1 line-clamp-2">
                      {a.bodyPreview}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className="sc-card p-4 flex flex-col gap-3"
            style={{ minHeight: 400 }}
          >
            {!activeAtomId && (
              <div className="sc-body opacity-60">
                Select an atom from the list to see its full text and source.
              </div>
            )}
            {activeAtomId && atomDetailQuery.isLoading && (
              <div className="sc-body opacity-60">Loading atom…</div>
            )}
            {activeAtomId && atomDetailQuery.error && (
              <div className="alert-block critical rounded-md">
                Failed to load atom.
              </div>
            )}
            {atomDetailQuery.data && (
              <>
                <div className="flex flex-col gap-1">
                  <div className="sc-medium">
                    {atomDetailQuery.data.sectionNumber ?? "—"}{" "}
                    {atomDetailQuery.data.sectionTitle ?? ""}
                  </div>
                  <div className="sc-meta opacity-70">
                    {atomDetailQuery.data.codeBook} ·{" "}
                    {atomDetailQuery.data.edition} ·{" "}
                    {atomDetailQuery.data.sourceName} · fetched{" "}
                    {relativeTime(atomDetailQuery.data.fetchedAt)}
                  </div>
                  <a
                    href={atomDetailQuery.data.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sc-meta inline-flex items-center gap-1"
                    style={{ color: "var(--cyan)" }}
                  >
                    Open source <ExternalLink size={11} />
                  </a>
                </div>
                <pre
                  data-testid="atom-body"
                  className="sc-scroll"
                  style={{
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 4,
                    padding: 12,
                    fontFamily: "inherit",
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                    lineHeight: 1.5,
                    maxHeight: 520,
                    overflow: "auto",
                  }}
                >
                  {atomDetailQuery.data.body}
                </pre>
                <div className="sc-meta opacity-50">
                  atom id: {atomDetailQuery.data.id}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default CodeLibrary;
