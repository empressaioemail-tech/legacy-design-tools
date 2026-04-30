/**
 * /dev/atoms/probe — Retrieval Probe.
 *
 * Operator-facing diagnostic that answers "for query X against engagement Y,
 * what does Claude actually see?" by hitting POST /api/dev/atoms/retrieve,
 * which runs the SAME retrieval module + assembles the SAME
 * `<reference_code_atoms>` XML block /api/chat does. The response carries
 * ALL retrieved atoms — the inclusion threshold the chat path actually
 * applies (cosine similarity floor; see `MIN_VECTOR_SCORE` in
 * `@workspace/codes`) is echoed in the response as `inclusionThreshold` and
 * drawn here as a horizontal divider between rows whose similarity crosses
 * it. We also accept a `THRESHOLD_FALLBACK` so the page still renders if a
 * hypothetical older server didn't include the field.
 *
 * Browser-side secret handling: this is the FIRST design-tools surface to
 * call a snapshot-secret-gated endpoint (POST /snapshots and POST
 * /engagements/match are Revit-side). We stash the operator-pasted secret
 * in localStorage under `devSnapshotSecret` so they only have to enter it
 * once per browser. Stored in plaintext, intentionally — this is a DEV
 * surface for trusted operators, not a public auth path. Secret is never
 * sent in the URL.
 *
 * URL sync: `?engagementId=…` OR `?jurisdiction=…`, plus `?query=…` and
 * optional `?topN=…`. The URL is the source of truth for the
 * deep-link / shareable state; secret is local-only.
 */
import { useEffect, useMemo, useState } from "react";
import {
  useListEngagements,
  useListCodeJurisdictions,
  retrieveAtomsProbe,
  getListEngagementsQueryKey,
  getListCodeJurisdictionsQueryKey,
} from "@workspace/api-client-react";
import type { RetrievalProbeResponse } from "@workspace/api-client-react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Search } from "lucide-react";

/**
 * Inclusion-threshold fallback used only when the probe response omits
 * `inclusionThreshold` (e.g. talking to an older server build). Kept in sync
 * with `MIN_VECTOR_SCORE` in `lib/codes/src/retrieval.ts` — that constant is
 * the canonical source of truth; this is just a safety net so the page
 * doesn't crash on a missing field.
 */
const THRESHOLD_FALLBACK = 0.35;
const SECRET_KEY = "devSnapshotSecret";
const TOPN_DEFAULT = 10;
const TOPN_MIN = 1;
const TOPN_MAX = 50;

interface ProbeFilters {
  engagementId: string;
  jurisdiction: string;
  query: string;
  topN: number;
}

const DEFAULT_FILTERS: ProbeFilters = {
  engagementId: "",
  jurisdiction: "",
  query: "",
  topN: TOPN_DEFAULT,
};

function readFiltersFromUrl(): ProbeFilters {
  const params = new URLSearchParams(window.location.search);
  const topNRaw = Number(params.get("topN") ?? "");
  const topN =
    Number.isFinite(topNRaw) && topNRaw >= TOPN_MIN && topNRaw <= TOPN_MAX
      ? Math.floor(topNRaw)
      : TOPN_DEFAULT;
  return {
    engagementId: params.get("engagementId") ?? "",
    jurisdiction: params.get("jurisdiction") ?? "",
    query: params.get("query") ?? "",
    topN,
  };
}

function writeFiltersToUrl(f: ProbeFilters): void {
  const params = new URLSearchParams();
  if (f.engagementId) params.set("engagementId", f.engagementId);
  if (f.jurisdiction) params.set("jurisdiction", f.jurisdiction);
  if (f.query) params.set("query", f.query);
  if (f.topN !== TOPN_DEFAULT) params.set("topN", String(f.topN));
  const qs = params.toString();
  // replaceState — the probe is exploratory, no need to fill back-button
  // history with intermediate query/topN typing states.
  window.history.replaceState(
    null,
    "",
    qs ? `?${qs}` : window.location.pathname,
  );
}

function readSecretFromStorage(): string {
  try {
    return window.localStorage.getItem(SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSecretToStorage(s: string): void {
  try {
    if (s) window.localStorage.setItem(SECRET_KEY, s);
    else window.localStorage.removeItem(SECRET_KEY);
  } catch {
    /* private mode / disabled storage — silently fall back to in-memory */
  }
}

/**
 * Where in the result list does the similarity drop below `threshold`?
 * Returns the index of the FIRST below-threshold row, or results.length
 * if every row passes (no divider needed). The UI draws the divider
 * BEFORE that row.
 */
function findThresholdSplitIndex(
  results: RetrievalProbeResponse["results"],
  threshold: number,
): number {
  for (let i = 0; i < results.length; i++) {
    if (results[i].similarity < threshold) return i;
  }
  return results.length;
}

export function DevAtomsProbe() {
  const [filters, setFilters] = useState<ProbeFilters>(() =>
    readFiltersFromUrl(),
  );
  const [secret, setSecret] = useState<string>(() => readSecretFromStorage());
  const [showPromptBlock, setShowPromptBlock] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [response, setResponse] = useState<RetrievalProbeResponse | null>(null);

  // Sync filters → URL.
  useEffect(() => {
    writeFiltersToUrl(filters);
  }, [filters]);

  const engagementsQuery = useListEngagements({
    query: {
      queryKey: getListEngagementsQueryKey(),
      // No polling; engagements rarely change while operator is debugging.
      staleTime: 30_000,
    },
  });
  const engagements = useMemo(
    () => engagementsQuery.data ?? [],
    [engagementsQuery.data],
  );

  const jurisdictionsQuery = useListCodeJurisdictions({
    query: {
      queryKey: getListCodeJurisdictionsQueryKey(),
      staleTime: 60_000,
    },
  });
  const jurisdictionOptions = useMemo(
    () => jurisdictionsQuery.data ?? [],
    [jurisdictionsQuery.data],
  );

  // Custom mutation rather than the generated `useRetrieveAtomsProbe` so we
  // can close over the operator-pasted secret and inject it as the
  // `x-snapshot-secret` header on every call. The generated hook wires its
  // `request` option at hook-init time, which would freeze the secret to
  // its initial empty value.
  const probeMutation = useMutation<
    RetrievalProbeResponse,
    Error,
    {
      engagementId?: string;
      jurisdiction?: string;
      query: string;
      topN: number;
    }
  >({
    mutationFn: (body) =>
      retrieveAtomsProbe(body, {
        headers: { "x-snapshot-secret": secret },
      }),
    onSuccess: (data) => setResponse(data),
    onError: () => setResponse(null),
  });

  // Mutually exclusive selection: choosing an engagement clears the manual
  // jurisdiction (and vice versa) — the UI mirrors the server's XOR rule.
  function patchEngagement(id: string): void {
    setFilters((f) => ({ ...f, engagementId: id, jurisdiction: "" }));
    setResponse(null);
  }
  function patchJurisdiction(key: string): void {
    setFilters((f) => ({ ...f, engagementId: "", jurisdiction: key }));
    setResponse(null);
  }
  function patchQuery(q: string): void {
    setFilters((f) => ({ ...f, query: q }));
  }
  function patchTopN(n: number): void {
    const clamped = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Math.floor(n) || TOPN_DEFAULT));
    setFilters((f) => ({ ...f, topN: clamped }));
  }

  function persistSecret(s: string): void {
    setSecret(s);
    writeSecretToStorage(s);
  }

  const hasSelection = !!filters.engagementId || !!filters.jurisdiction;
  const queryTrimmed = filters.query.trim();
  const canRun =
    hasSelection && !!queryTrimmed && !!secret && !probeMutation.isPending;

  function runProbe(): void {
    if (!canRun) return;
    probeMutation.mutate({
      engagementId: filters.engagementId || undefined,
      jurisdiction: filters.jurisdiction || undefined,
      query: queryTrimmed,
      topN: filters.topN,
    });
  }

  async function copyPromptBlock(): Promise<void> {
    if (!response?.assembledPromptBlock) return;
    try {
      await navigator.clipboard.writeText(response.assembledPromptBlock);
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("failed");
      setTimeout(() => setCopyState("idle"), 1500);
    }
  }

  const results = response?.results ?? [];
  // The server echoes the canonical inclusion threshold so this divider can
  // never drift from what /api/chat actually applies. Fall back to a local
  // constant only if the server omitted the field (e.g. older build).
  const threshold = response?.inclusionThreshold ?? THRESHOLD_FALLBACK;
  const thresholdLabel = threshold.toFixed(2);
  const splitIdx = findThresholdSplitIndex(results, threshold);
  const aboveCount = splitIdx;
  const belowCount = results.length - splitIdx;
  const lexicalMode = response?.queryEmbedding.available === false;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl">Retrieval Probe</h1>
        <p className="sc-body opacity-80">
          For a given engagement (or raw jurisdiction key) and a query, runs
          the same atom retrieval Claude uses and shows you ALL ranked atoms
          — plus the literal prompt block that would be injected. Use the{" "}
          <a className="underline" href="../atoms">
            Atom Inspector
          </a>{" "}
          to browse the full atom corpus.
        </p>
      </header>

      {/* Snapshot secret — local-only, never in URL */}
      <div className="rounded border border-amber-700/60 bg-amber-950/30 p-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="opacity-80">
            Snapshot secret (paste once, stored in this browser only)
          </span>
          <input
            type="password"
            data-testid="probe-secret-input"
            placeholder="x-snapshot-secret value"
            className="w-full rounded bg-zinc-900 px-2 py-1 font-mono text-sm"
            value={secret}
            onChange={(e) => persistSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded border border-zinc-700 p-3">
        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Engagement</span>
          <select
            data-testid="probe-engagement-select"
            className="min-w-[18rem] rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.engagementId}
            onChange={(e) => patchEngagement(e.target.value)}
          >
            <option value="">— none (use jurisdiction below) —</option>
            {engagements.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
                {e.jurisdiction ? ` · ${e.jurisdiction}` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Jurisdiction (manual)</span>
          <select
            data-testid="probe-jurisdiction-select"
            className="min-w-[14rem] rounded bg-zinc-900 px-2 py-1 text-sm disabled:opacity-50"
            value={filters.jurisdiction}
            disabled={!!filters.engagementId}
            onChange={(e) => patchJurisdiction(e.target.value)}
          >
            <option value="">— pick a jurisdiction —</option>
            {jurisdictionOptions.map((j) => (
              <option key={j.key} value={j.key}>
                {j.displayName} ({j.key})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs">
          <span className="opacity-70">Top N (1–50)</span>
          <input
            type="number"
            min={TOPN_MIN}
            max={TOPN_MAX}
            data-testid="probe-topn-input"
            className="w-20 rounded bg-zinc-900 px-2 py-1 text-sm"
            value={filters.topN}
            onChange={(e) => patchTopN(Number(e.target.value))}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs opacity-70">Query</span>
        <textarea
          data-testid="probe-query-textarea"
          rows={3}
          placeholder="e.g. What is the maximum building height in a residential zone?"
          className="rounded bg-zinc-900 px-3 py-2 font-mono text-sm"
          value={filters.query}
          onChange={(e) => patchQuery(e.target.value)}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="probe-run-button"
          disabled={!canRun}
          onClick={runProbe}
          className="inline-flex items-center gap-2 rounded border border-zinc-500 bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Search size={14} />
          {probeMutation.isPending ? "Running…" : "Run probe"}
        </button>
        {!hasSelection && (
          <span className="text-xs opacity-70">
            Pick an engagement OR a jurisdiction.
          </span>
        )}
        {hasSelection && !queryTrimmed && (
          <span className="text-xs opacity-70">Enter a query.</span>
        )}
        {hasSelection && queryTrimmed && !secret && (
          <span className="text-xs text-amber-400">
            Paste the snapshot secret above.
          </span>
        )}
      </div>

      {probeMutation.error && !response && (
        <div
          data-testid="probe-error"
          className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200"
        >
          Probe failed: {String((probeMutation.error as Error).message ?? probeMutation.error)}
        </div>
      )}

      {response && (
        <>
          {/* Resolution + mode strip */}
          <div className="flex flex-wrap items-center gap-4 rounded border border-zinc-700 bg-zinc-900/50 p-3 text-xs">
            <span>
              <span className="opacity-70">resolved jurisdiction:</span>{" "}
              <span className="font-mono">{response.resolvedJurisdiction}</span>
              {response.resolvedFromEngagement && (
                <span className="ml-1 opacity-60">(from engagement)</span>
              )}
            </span>
            <span>
              <span className="opacity-70">retrieval:</span>{" "}
              <span
                className={
                  lexicalMode
                    ? "rounded bg-amber-900/60 px-1.5 py-0.5 text-amber-200"
                    : "rounded bg-emerald-900/60 px-1.5 py-0.5 text-emerald-200"
                }
              >
                {lexicalMode ? "lexical (no embedding key)" : "vector"}
              </span>
            </span>
            <span>
              <span className="opacity-70">embedding model:</span>{" "}
              <span className="font-mono">{response.queryEmbedding.model}</span>{" "}
              <span className="opacity-50">({response.queryEmbedding.dimension}d)</span>
            </span>
            <span>
              <span className="opacity-70">returned:</span> {results.length}{" "}
              {results.length > 0 && (
                <span className="opacity-60">
                  ({aboveCount} above {thresholdLabel}, {belowCount} below)
                </span>
              )}
            </span>
          </div>

          {lexicalMode && (
            <div className="rounded border border-amber-700/60 bg-amber-950/30 p-2 text-xs text-amber-200">
              No OPENAI_API_KEY on the server — retrieval fell back to lexical
              bag-of-words. Scores below are <strong>integer match counts</strong>,
              not cosine similarities; the {thresholdLabel} threshold doesn't
              apply in this mode.
            </div>
          )}

          {/* Results table */}
          <div className="overflow-auto rounded border border-zinc-700">
            <table className="w-full table-auto text-sm">
              <thead className="sticky top-0 bg-zinc-900 text-xs uppercase opacity-80">
                <tr>
                  <th className="px-2 py-2 text-left">#</th>
                  <th className="px-2 py-2 text-left">Score</th>
                  <th className="px-2 py-2 text-left">Code ref</th>
                  <th className="px-2 py-2 text-left">Title</th>
                  <th className="px-2 py-2 text-left">Body preview</th>
                  <th className="px-2 py-2 text-left">Source</th>
                </tr>
              </thead>
              <tbody>
                {results.flatMap((r, i) => {
                  const showDivider = !lexicalMode && i === splitIdx && i > 0;
                  const rows = [];
                  if (showDivider) {
                    rows.push(
                      <tr
                        key={`divider-${i}`}
                        data-testid="threshold-divider"
                      >
                        <td
                          colSpan={6}
                          className="border-y-2 border-amber-600/70 bg-amber-950/20 px-2 py-1 text-center text-[11px] uppercase tracking-wider text-amber-200"
                        >
                          {thresholdLabel} threshold — atoms above are
                          included in chat context
                        </td>
                      </tr>,
                    );
                  }
                  rows.push(
                    <tr
                      key={r.atomId}
                      data-testid="probe-result-row"
                      className={
                        "border-t border-zinc-800 " +
                        (!lexicalMode && i >= splitIdx ? "opacity-60" : "")
                      }
                    >
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                        {r.rank}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                        {lexicalMode ? r.similarity : r.similarity.toFixed(4)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 font-mono text-xs">
                        {r.codeRef}
                      </td>
                      <td className="px-2 py-1">{r.sectionTitle ?? "—"}</td>
                      <td className="px-2 py-1 text-xs opacity-90">
                        {r.bodyPreview}
                      </td>
                      <td className="whitespace-nowrap px-2 py-1 text-xs">
                        <span className="font-mono opacity-70">
                          {r.sourceBook}
                        </span>
                        {r.sourceUrl && (
                          <>
                            {" "}
                            <a
                              href={r.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline opacity-70"
                            >
                              src
                            </a>
                          </>
                        )}
                      </td>
                    </tr>,
                  );
                  return rows;
                })}
                {results.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-2 py-6 text-center opacity-60"
                    >
                      No atoms returned for this query.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Assembled prompt block */}
          <details
            className="rounded border border-zinc-700"
            open={showPromptBlock}
            onToggle={(e) =>
              setShowPromptBlock((e.target as HTMLDetailsElement).open)
            }
          >
            <summary className="cursor-pointer px-3 py-2 text-sm">
              View assembled <code>&lt;reference_code_atoms&gt;</code> block (
              {response.assembledPromptBlock.length} chars)
            </summary>
            <div className="flex flex-col gap-2 border-t border-zinc-700 p-3">
              <button
                type="button"
                data-testid="probe-copy-button"
                onClick={copyPromptBlock}
                disabled={!response.assembledPromptBlock}
                className="inline-flex w-fit items-center gap-2 rounded border border-zinc-600 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"
              >
                <Copy size={12} />
                {copyState === "copied"
                  ? "Copied!"
                  : copyState === "failed"
                    ? "Copy failed"
                    : "Copy to clipboard"}
              </button>
              <pre
                data-testid="probe-prompt-block"
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-3 text-xs"
              >
                {response.assembledPromptBlock || "(empty — no atoms retrieved)"}
              </pre>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

export default DevAtomsProbe;
