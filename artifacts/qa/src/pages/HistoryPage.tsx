import { useState } from "react";
import {
  useListQaRuns,
  useGetQaRun,
  getListQaRunsQueryKey,
  getGetQaRunQueryKey,
  type QaRunSummary,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { RotateCw } from "lucide-react";
import { AddToTriageButton } from "@/components/triage";

export default function HistoryPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const runsQuery = useListQaRuns(
    { limit: 50 },
    {
      query: {
        queryKey: getListQaRunsQueryKey({ limit: 50 }),
        refetchInterval: 5_000,
      },
    },
  );
  const runs = runsQuery.data?.runs ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">Recent runs</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runsQuery.refetch()}
            disabled={runsQuery.isFetching}
            data-testid="button-refresh-history"
          >
            <RotateCw
              className={`h-4 w-4 ${runsQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="h-[60vh]">
            {runs.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">
                No runs recorded yet.
              </div>
            ) : (
              <ul className="divide-y">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      onClick={() => setSelected(run.id)}
                      className={`w-full px-4 py-3 text-left hover:bg-muted ${
                        selected === run.id ? "bg-muted" : ""
                      }`}
                      data-testid={`row-run-${run.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-sm">{run.suiteId}</div>
                        <RunStatusBadge status={run.status} />
                      </div>
                      <RunRowMeta run={run} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="min-h-[60vh]">
        {selected ? (
          <RunDetail runId={selected} />
        ) : (
          <CardContent className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a run to view its log.
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function RunRowMeta({ run }: { run: QaRunSummary }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{formatTimestamp(run.startedAt)}</span>
      <div className="flex items-center gap-2">
        <span>{formatDuration(run.durationMs)}</span>
        {run.status === "failed" || run.status === "errored" ? (
          <span
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <AddToTriageButton
              testId={`history-triage-${run.id}`}
              label="Triage"
              body={{
                sourceKind: "run",
                sourceId: run.id,
                sourceRunId: run.id,
                suiteId: run.suiteId,
                title: `${run.suiteId} run failed`,
                severity: "error",
                excerpt: "",
                suggestedNextStep: "Open the run log and identify root cause.",
              }}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const runQuery = useGetQaRun(runId, {
    query: {
      queryKey: getGetQaRunQueryKey(runId),
      refetchInterval: (q) => (q.state.data?.isActive ? 2_000 : false),
    },
  });
  const run = runQuery.data;
  if (runQuery.isError) {
    return (
      <CardContent
        data-testid={`detail-error-${runId}`}
        className="flex h-full flex-col items-center justify-center gap-3 text-sm text-rose-700"
      >
        <div>Could not load run log.</div>
        <div className="text-xs text-muted-foreground">
          {runQuery.error instanceof Error ? runQuery.error.message : "Unknown error"}
        </div>
        <Button variant="outline" size="sm" onClick={() => runQuery.refetch()}>
          Retry
        </Button>
      </CardContent>
    );
  }
  if (!run) {
    return (
      <CardContent className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </CardContent>
    );
  }
  return (
    <>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{run.suiteId}</CardTitle>
          <div className="flex items-center gap-2">
            {run.status === "failed" || run.status === "errored" ? (
              <AddToTriageButton
                testId={`history-detail-triage-${run.id}`}
                body={{
                  sourceKind: "run",
                  sourceId: run.id,
                  sourceRunId: run.id,
                  suiteId: run.suiteId,
                  title: `${run.suiteId} run failed`,
                  severity: "error",
                  excerpt: (run.log ?? "").slice(-1500),
                  suggestedNextStep: "Inspect the captured log and root cause.",
                }}
              />
            ) : null}
            <RunStatusBadge status={run.status} />
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Started {formatTimestamp(run.startedAt)}</span>
          <span>{formatDuration(run.durationMs)}</span>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[55vh] rounded border bg-slate-950">
          <pre
            data-testid={`detail-log-${run.id}`}
            className="p-3 text-[11px] leading-snug text-slate-100 font-mono whitespace-pre-wrap break-words"
          >
            {run.log || "(no output captured)"}
          </pre>
        </ScrollArea>
      </CardContent>
    </>
  );
}
