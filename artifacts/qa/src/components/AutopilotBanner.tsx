import {
  useGetQaAutopilotState,
  useStartQaAutopilotRun,
  useUpdateQaAutopilotSettings,
  getGetQaAutopilotStateQueryKey,
  getListQaAutopilotRunsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Bot, AlertCircle, CheckCircle2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatRelative, formatDuration } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";

/**
 * Top-of-dashboard banner for the autopilot (Task #482).
 *
 * Always visible across every tab. Renders the toggle, "Run now"
 * button, and the latest run summary (pass/fail/flaky/auto-fix
 * counts). Auto-triggers a run on mount when the toggle is on AND
 * no run has happened in the current session — that gives the
 * "kicks off automatically as soon as the dashboard is opened"
 * behavior without any background cron.
 */
export function AutopilotBanner() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const stateQuery = useGetQaAutopilotState({
    query: {
      queryKey: getGetQaAutopilotStateQueryKey(),
      refetchInterval: (q) => (q.state.data?.activeRunId ? 3_000 : 15_000),
    },
  });
  const startMutation = useStartQaAutopilotRun({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getGetQaAutopilotStateQueryKey() });
        void qc.invalidateQueries({
          queryKey: getListQaAutopilotRunsQueryKey(),
        });
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast({
          title: "Could not start autopilot",
          description: message,
          variant: "destructive",
        });
      },
    },
  });
  const settingsMutation = useUpdateQaAutopilotSettings({
    mutation: {
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: getGetQaAutopilotStateQueryKey() }),
    },
  });

  const state = stateQuery.data;
  const autoTriggered = useRef(false);
  useEffect(() => {
    if (autoTriggered.current) return;
    if (!state) return;
    if (!state.enabled) return;
    if (state.activeRunId) {
      // Already running from a prior session — no need to trigger.
      autoTriggered.current = true;
      return;
    }
    autoTriggered.current = true;
    startMutation.mutate({ data: { trigger: "auto-on-open" } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const latest = state?.latestRun;
  const isActive = Boolean(state?.activeRunId);

  return (
    <div
      data-testid="autopilot-banner"
      className="rounded-lg border bg-white px-4 py-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="rounded-md bg-slate-900 p-1.5 text-white">
            <Bot className="h-4 w-4" />
          </div>
          <div className="text-sm">
            <div className="font-semibold tracking-tight">Autopilot</div>
            <div className="text-xs text-muted-foreground">
              {isActive
                ? "Running every suite now…"
                : latest
                  ? `Last run ${formatRelative(latest.startedAt)}${
                      latest.durationMs != null
                        ? ` · ${formatDuration(latest.durationMs)}`
                        : ""
                    }`
                  : "Not run yet"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {latest ? (
            <div className="flex items-center gap-3 text-xs">
              <CountChip
                label="passing"
                value={latest.passing}
                tone="emerald"
              />
              <CountChip label="failing" value={latest.failing} tone="rose" />
              <CountChip label="flaky" value={latest.flaky} tone="amber" />
              <CountChip
                label="auto-fixed"
                value={latest.autoFixesApplied}
                tone="sky"
              />
              <CountChip
                label="needs review"
                value={latest.needsReview}
                tone="violet"
              />
            </div>
          ) : null}
          <div className="flex items-center gap-2 border-l pl-3">
            <span className="text-xs text-muted-foreground">Autopilot</span>
            <Switch
              data-testid="autopilot-toggle"
              checked={state?.enabled ?? false}
              disabled={settingsMutation.isPending || !state}
              onCheckedChange={(v) =>
                settingsMutation.mutate({ data: { enabled: v } })
              }
            />
            <Button
              size="sm"
              data-testid="autopilot-run-now"
              disabled={isActive || startMutation.isPending}
              onClick={() =>
                startMutation.mutate({ data: { trigger: "manual" } })
              }
            >
              {isActive || startMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Run now
            </Button>
          </div>
        </div>
      </div>
      {latest?.status === "errored" ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
          <AlertCircle className="h-3.5 w-3.5" />
          The last autopilot run errored. See run history for details.
        </div>
      ) : null}
      {latest?.status === "completed" &&
      latest.failing === 0 &&
      latest.needsReview === 0 ? (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
          <CheckCircle2 className="h-3.5 w-3.5" />
          All suites green — nothing waiting on review.
        </div>
      ) : null}
    </div>
  );
}

const TONE_CLASS: Record<string, string> = {
  emerald: "bg-emerald-50 text-emerald-800 border-emerald-200",
  rose: "bg-rose-50 text-rose-800 border-rose-200",
  amber: "bg-amber-50 text-amber-800 border-amber-200",
  sky: "bg-sky-50 text-sky-800 border-sky-200",
  violet: "bg-violet-50 text-violet-800 border-violet-200",
};

function CountChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: keyof typeof TONE_CLASS | string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
        TONE_CLASS[tone] ?? "bg-slate-50 text-slate-700 border-slate-200"
      }`}
      data-testid={`autopilot-count-${label.replace(/\s+/g, "-")}`}
    >
      <span className="font-semibold">{value}</span>
      <span className="opacity-80">{label}</span>
    </span>
  );
}
