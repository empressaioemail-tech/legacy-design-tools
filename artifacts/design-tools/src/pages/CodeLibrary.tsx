import { useEffect, useMemo, useState } from "react";
import {
  useListCodeJurisdictions,
  useListJurisdictionAtoms,
  useGetCodeAtom,
  warmupJurisdiction,
  getListCodeJurisdictionsQueryKey,
  getListJurisdictionAtomsQueryKey,
  getGetCodeAtomQueryKey,
  type JurisdictionSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { BookOpen, ExternalLink, RefreshCw } from "lucide-react";

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

export function CodeLibrary() {
  const qc = useQueryClient();
  const { data: jurisdictions, isLoading } = useListCodeJurisdictions({
    query: {
      queryKey: getListCodeJurisdictionsQueryKey(),
      refetchInterval: 5000,
    },
  });

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [activeAtomId, setActiveAtomId] = useState<string | null>(() =>
    readAtomFromHash(),
  );
  const [warming, setWarming] = useState<Record<string, boolean>>({});
  const [warmupMsg, setWarmupMsg] = useState<Record<string, string>>({});

  // First jurisdiction selected by default once data arrives.
  useEffect(() => {
    if (!activeKey && jurisdictions && jurisdictions.length > 0) {
      setActiveKey(jurisdictions[0].key);
    }
  }, [jurisdictions, activeKey]);

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

  const atomsQuery = useListJurisdictionAtoms(
    activeKey ?? "",
    { limit: 100 },
    {
      query: {
        enabled: !!activeKey,
        queryKey: activeKey
          ? getListJurisdictionAtomsQueryKey(activeKey, { limit: 100 })
          : ["codes", "atoms", "none"],
        refetchInterval: 5000,
      },
    },
  );

  const handleWarmup = async (key: string) => {
    setWarming((w) => ({ ...w, [key]: true }));
    setWarmupMsg((m) => ({ ...m, [key]: "" }));
    try {
      const res = await warmupJurisdiction(key);
      setWarmupMsg((m) => ({
        ...m,
        [key]: `Enqueued ${res.enqueued} new, skipped ${res.skipped}, drained ${res.drained.completed}/${res.drained.picked} (failed ${res.drained.failed}, +${res.drained.atomsWritten} atoms).`,
      }));
      // Refresh both lists.
      void qc.invalidateQueries({ queryKey: getListCodeJurisdictionsQueryKey() });
      if (activeKey) {
        void qc.invalidateQueries({
          queryKey: getListJurisdictionAtomsQueryKey(activeKey, { limit: 100 }),
        });
      }
    } catch (err) {
      setWarmupMsg((m) => ({
        ...m,
        [key]: `Warmup failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setWarming((w) => ({ ...w, [key]: false }));
    }
  };

  const activeJurisdiction = useMemo<JurisdictionSummary | undefined>(
    () => jurisdictions?.find((j) => j.key === activeKey),
    [jurisdictions, activeKey],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <BookOpen size={20} />
        <h1 className="text-2xl">Code Library</h1>
      </div>
      <p className="sc-body opacity-70">
        Atom-anchored code knowledge. Atoms are fetched on demand the first time
        an engagement geocodes to a configured jurisdiction. Click a card to
        browse its atoms, or open one to see the full text and source link.
      </p>

      {isLoading && <div className="sc-body">Loading jurisdictions…</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(jurisdictions ?? []).map((j) => {
          const isActive = j.key === activeKey;
          return (
            <div
              key={j.key}
              className="sc-card p-4 flex flex-col gap-3 cursor-pointer"
              style={{
                borderColor: isActive ? "var(--cyan)" : "var(--border-default)",
                borderWidth: isActive ? 2 : 1,
                borderStyle: "solid",
                borderRadius: 6,
              }}
              onClick={() => setActiveKey(j.key)}
            >
              <div className="flex items-center justify-between">
                <div className="sc-medium">{j.displayName}</div>
                <div className="sc-meta opacity-60">{j.key}</div>
              </div>
              <div className="flex items-baseline gap-4">
                <div>
                  <div className="text-2xl">{j.atomCount}</div>
                  <div className="sc-meta opacity-60">atoms</div>
                </div>
                <div>
                  <div className="text-2xl">{j.embeddedCount}</div>
                  <div className="sc-meta opacity-60">embedded</div>
                </div>
                <div className="ml-auto sc-meta opacity-60">
                  Last fetched {relativeTime(j.lastFetchedAt)}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {j.books.map((b) => (
                  <span
                    key={`${b.codeBook}|${b.edition}`}
                    className="sc-pill"
                    title={`${b.label} via ${b.sourceName}`}
                    style={{
                      background: "rgba(99, 152, 170, 0.15)",
                      color: "var(--cyan)",
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 3,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                    }}
                  >
                    {b.label} · {b.atomCount}
                  </span>
                ))}
              </div>
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="sc-btn-secondary inline-flex items-center gap-1"
                  disabled={warming[j.key]}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleWarmup(j.key);
                  }}
                  style={{ fontSize: 11, padding: "4px 8px" }}
                >
                  <RefreshCw size={12} />
                  {warming[j.key] ? "Warming up…" : "Warm up now"}
                </button>
                {warmupMsg[j.key] && (
                  <div className="sc-meta opacity-70 max-w-[60%] text-right">
                    {warmupMsg[j.key]}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {activeKey && activeJurisdiction && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-4">
          <div className="sc-card p-3 flex flex-col" style={{ minHeight: 400 }}>
            <div className="sc-card-header flex items-center justify-between">
              <span className="sc-label">
                {activeJurisdiction.displayName} · Atoms
              </span>
              <span className="sc-meta opacity-60">
                {atomsQuery.data?.length ?? 0}
              </span>
            </div>
            <div
              className="flex-1 overflow-y-auto sc-scroll mt-2 flex flex-col gap-1"
              style={{ maxHeight: 600 }}
            >
              {atomsQuery.isLoading && (
                <div className="sc-body opacity-60 p-2">Loading…</div>
              )}
              {!atomsQuery.isLoading && (atomsQuery.data?.length ?? 0) === 0 && (
                <div className="sc-body opacity-60 p-2">
                  No atoms yet. Try “Warm up now”.
                </div>
              )}
              {(atomsQuery.data ?? []).map((a) => {
                const isActive = a.id === activeAtomId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => setActiveAtomId(a.id)}
                    className="sc-ui text-left"
                    style={{
                      background: isActive
                        ? "rgba(0,180,216,0.10)"
                        : "transparent",
                      border: "1px solid",
                      borderColor: isActive
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

          <div className="sc-card p-4 flex flex-col gap-3" style={{ minHeight: 400 }}>
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
