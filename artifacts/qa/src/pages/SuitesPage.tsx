import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListQaSuites,
  useStartQaRun,
  useStartAllQaRuns,
  getListQaSuitesQueryKey,
  getListQaRunsQueryKey,
  getGetQaRunQueryKey,
  type QaSuiteSummary,
  type QaRunStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { RunStatusBadge } from "@/components/StatusBadge";
import { formatDuration, formatRelative } from "@/lib/format";
import { apiUrl } from "@/lib/api";
import { Loader2, Play, RotateCw } from "lucide-react";
import { AddToTriageButton } from "@/components/triage";
import { useGetQaRun, getGetQaRunQueryKey as getRunKey } from "@workspace/api-client-react";

interface ActiveStream {
  runId: string;
  suiteId: string;
  log: string;
  status: QaRunStatus;
  exitCode: number | null;
  durationMs: number | null;
}

function appAccent(app: QaSuiteSummary["app"]): string {
  switch (app) {
    case "api-server":
      return "bg-violet-50 text-violet-800 border-violet-200";
    case "design-tools":
      return "bg-sky-50 text-sky-800 border-sky-200";
    case "plan-review":
      return "bg-amber-50 text-amber-900 border-amber-200";
  }
}

export default function SuitesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const suitesQuery = useListQaSuites({
    query: {
      queryKey: getListQaSuitesQueryKey(),
      refetchInterval: (q) => {
        const data = q.state.data;
        if (data && data.suites.some((s) => s.activeRunId)) return 2_000;
        return 15_000;
      },
    },
  });
  const startMutation = useStartQaRun({
    mutation: {
      onSuccess: (resp) => {
        attachStream(resp.runId, resp.suiteId);
        void qc.invalidateQueries({ queryKey: getListQaSuitesQueryKey() });
        void qc.invalidateQueries({ queryKey: getListQaRunsQueryKey() });
      },
      onError: (err: unknown, vars) => {
        const message = err instanceof Error ? err.message : String(err);
        toast({
          title: `Could not start ${vars.data.suiteId}`,
          description: message,
          variant: "destructive",
        });
      },
    },
  });
  const startAllMutation = useStartAllQaRuns({
    mutation: {
      onSuccess: (resp) => {
        for (const s of resp.started) attachStream(s.runId, s.suiteId);
        if (resp.skipped.length > 0) {
          toast({
            title: "Some suites were skipped",
            description: resp.skipped
              .map((s) => `${s.suiteId}: ${s.reason}`)
              .join("\n"),
          });
        }
        void qc.invalidateQueries({ queryKey: getListQaSuitesQueryKey() });
      },
    },
  });

  const [streams, setStreams] = useState<Record<string, ActiveStream>>({});
  const eventSourceRefs = useRef<Map<string, EventSource>>(new Map());

  const attachStream = (runId: string, suiteId: string) => {
    if (eventSourceRefs.current.has(runId)) return;
    const es = new EventSource(apiUrl(`/api/qa/runs/${runId}/stream`));
    eventSourceRefs.current.set(runId, es);
    setStreams((prev) => ({
      ...prev,
      [suiteId]: {
        runId,
        suiteId,
        log: "",
        status: "running",
        exitCode: null,
        durationMs: null,
      },
    }));
    es.addEventListener("log", (ev) => {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        type: "log";
        data: string;
      };
      setStreams((prev) => {
        const cur = prev[suiteId];
        if (!cur || cur.runId !== runId) return prev;
        return { ...prev, [suiteId]: { ...cur, log: cur.log + payload.data } };
      });
    });
    es.addEventListener("done", (ev) => {
      const payload = JSON.parse((ev as MessageEvent).data) as {
        type: "done";
        status: QaRunStatus;
        exitCode: number | null;
        durationMs: number;
      };
      setStreams((prev) => {
        const cur = prev[suiteId];
        if (!cur || cur.runId !== runId) return prev;
        return {
          ...prev,
          [suiteId]: {
            ...cur,
            status: payload.status,
            exitCode: payload.exitCode,
            durationMs: payload.durationMs,
          },
        };
      });
      es.close();
      eventSourceRefs.current.delete(runId);
      void qc.invalidateQueries({ queryKey: getListQaSuitesQueryKey() });
      void qc.invalidateQueries({ queryKey: getListQaRunsQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetQaRunQueryKey(runId) });
    });
    es.onerror = () => {
      // EventSource auto-reconnects; only force-close if the run is
      // demonstrably done. Otherwise let it retry.
      // (No-op — the `done` handler already closes.)
    };
  };

  // Auto-attach to suites that the server reports as already running
  // (e.g. on page reload while a suite from a previous session is
  // mid-flight).
  useEffect(() => {
    const suites = suitesQuery.data?.suites ?? [];
    for (const s of suites) {
      if (s.activeRunId && !eventSourceRefs.current.has(s.activeRunId)) {
        attachStream(s.activeRunId, s.id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suitesQuery.data]);

  useEffect(() => {
    return () => {
      for (const es of eventSourceRefs.current.values()) es.close();
      eventSourceRefs.current.clear();
    };
  }, []);

  const suites = suitesQuery.data?.suites ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Automated suites</h2>
          <p className="text-sm text-muted-foreground">
            Trigger pnpm test scripts and watch live output. History persists in Postgres.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => suitesQuery.refetch()}
            disabled={suitesQuery.isFetching}
            data-testid="button-refresh-suites"
          >
            <RotateCw
              className={`mr-2 h-4 w-4 ${suitesQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => startAllMutation.mutate()}
            disabled={startAllMutation.isPending}
            data-testid="button-run-all"
          >
            {startAllMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            Run all
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {suites.map((suite) => {
          const stream = streams[suite.id];
          const isActive = Boolean(suite.activeRunId) || stream?.status === "running";
          return (
            <SuiteCard
              key={suite.id}
              suite={suite}
              stream={stream}
              isActive={isActive}
              onStart={() =>
                startMutation.mutate({ data: { suiteId: suite.id } })
              }
              starting={
                startMutation.isPending &&
                startMutation.variables?.data.suiteId === suite.id
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function SuiteCard({
  suite,
  stream,
  isActive,
  onStart,
  starting,
}: {
  suite: QaSuiteSummary;
  stream: ActiveStream | undefined;
  isActive: boolean;
  onStart: () => void;
  starting: boolean;
}) {
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [stream?.log]);

  const lastStatus = useMemo<QaRunStatus | null>(() => {
    if (stream) return stream.status;
    return suite.lastRun?.status ?? null;
  }, [stream, suite.lastRun]);

  const lastDuration = stream?.durationMs ?? suite.lastRun?.durationMs ?? null;
  const lastWhen = suite.lastRun?.startedAt ?? null;

  return (
    <Card data-testid={`card-suite-${suite.id}`} className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={`text-[10px] uppercase tracking-wide ${appAccent(
                  suite.app,
                )}`}
              >
                {suite.app}
              </Badge>
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {suite.kind}
              </Badge>
            </div>
            <CardTitle className="text-base">{suite.label}</CardTitle>
            <CardDescription className="text-xs">{suite.description}</CardDescription>
          </div>
          <Button
            size="sm"
            onClick={onStart}
            disabled={isActive || starting}
            data-testid={`button-run-${suite.id}`}
          >
            {isActive || starting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            {isActive ? "Running" : "Run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <RunStatusBadge status={lastStatus} />
            <span className="text-muted-foreground">
              {formatDuration(lastDuration)}
            </span>
          </div>
          <span className="text-muted-foreground">
            {stream ? "live" : formatRelative(lastWhen)}
          </span>
        </div>
        <Separator />
        <SuiteLastLog suite={suite} stream={stream} logRef={logRef} />
        {(lastStatus === "failed" || lastStatus === "errored") && suite.lastRun ? (
          <div className="flex justify-end">
            <AddToTriageButton
              testId={`suite-triage-${suite.id}`}
              label="Add failure to triage"
              body={{
                sourceKind: "suite_failure",
                sourceId: suite.id,
                sourceRunId: suite.lastRun.id,
                suiteId: suite.id,
                title: `${suite.label} suite failed`,
                severity: "error",
                excerpt: "",
                suggestedNextStep:
                  "Inspect the linked run log and propose a fix.",
              }}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SuiteLastLog({
  suite,
  stream,
  logRef,
}: {
  suite: QaSuiteSummary;
  stream: ActiveStream | undefined;
  logRef: React.RefObject<HTMLPreElement | null>;
}) {
  // Fetch the persisted log of the last run when there's no live
  // stream so reviewers can read it inline without bouncing to Run
  // History (Task #503).
  const lastRunId = suite.lastRun?.id ?? null;
  const runQuery = useGetQaRun(lastRunId ?? "", {
    query: {
      enabled: !stream && !!lastRunId,
      queryKey: getRunKey(lastRunId ?? ""),
      staleTime: 30_000,
    },
  });
  let log: string;
  if (stream?.log) {
    log = stream.log;
  } else if (runQuery.isError) {
    log = `Could not load last run log: ${
      runQuery.error instanceof Error ? runQuery.error.message : "unknown error"
    }`;
  } else if (runQuery.data?.log != null) {
    log = runQuery.data.log;
  } else if (suite.lastRun && runQuery.isFetching) {
    log = "Loading last run…";
  } else if (suite.lastRun) {
    log = "(no output captured)";
  } else {
    log = "No runs yet. Click Run to kick off this suite.";
  }
  return (
    <ScrollArea className="h-48 rounded border bg-slate-950">
      <pre
        ref={logRef}
        data-testid={`log-${suite.id}`}
        className={`p-3 text-[11px] leading-snug font-mono whitespace-pre-wrap break-words ${
          runQuery.isError ? "text-rose-300" : "text-slate-100"
        }`}
      >
        {log}
      </pre>
    </ScrollArea>
  );
}
