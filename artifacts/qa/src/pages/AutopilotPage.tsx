import { useEffect, useMemo, useState } from "react";
import {
  useGetQaAutopilotState,
  useGetQaAutopilotRun,
  useListQaAutopilotRuns,
  useUpdateQaAutopilotSettings,
  getGetQaAutopilotStateQueryKey,
  getGetQaAutopilotRunQueryKey,
  getListQaAutopilotRunsQueryKey,
  QaAutopilotNotifyMinSeverity,
  type QaAutopilotFinding,
  type QaAutopilotFindingAutoFixStatus,
  type QaAutopilotFindingCategory,
  type QaAutopilotFixAction,
  type QaAutopilotRunSummary,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { formatDuration, formatRelative, formatTimestamp } from "@/lib/format";
import { Loader2, Copy, Check } from "lucide-react";

/**
 * Autopilot Findings Report (Task #482).
 *
 * Two-pane layout: left = run-history list, right = findings detail
 * for the selected run, grouped by suite. Auto-selects the most
 * recent run when nothing has been picked yet.
 */
export default function AutopilotPage() {
  const stateQuery = useGetQaAutopilotState({
    query: {
      queryKey: getGetQaAutopilotStateQueryKey(),
      refetchInterval: (q) => (q.state.data?.activeRunId ? 3_000 : 15_000),
    },
  });
  const runsQuery = useListQaAutopilotRuns(
    { limit: 25 },
    {
      query: {
        queryKey: getListQaAutopilotRunsQueryKey({ limit: 25 }),
        refetchInterval: 5_000,
      },
    },
  );
  const runs = runsQuery.data?.runs ?? [];

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const effectiveRunId =
    selectedRunId ?? stateQuery.data?.latestRun?.id ?? runs[0]?.id ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Autopilot — Findings Report
          </h2>
          <p className="text-sm text-muted-foreground">
            Latest sweep across every registered suite, grouped by failure with
            auto-fix status.
          </p>
        </div>
      </div>

      <NotificationsCard />

      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Recent autopilot runs</CardTitle>
            <CardDescription className="text-xs">
              Newest first. Pick a run to inspect its findings.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[60vh]">
              {runs.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">
                  No autopilot runs recorded yet.
                </div>
              ) : (
                <ul className="divide-y" data-testid="autopilot-run-list">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <button
                        onClick={() => setSelectedRunId(run.id)}
                        className={`w-full px-4 py-3 text-left hover:bg-muted ${
                          effectiveRunId === run.id ? "bg-muted" : ""
                        }`}
                        data-testid={`autopilot-run-${run.id}`}
                      >
                        <RunRow run={run} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="min-h-[60vh]">
          {effectiveRunId ? (
            <RunDetail runId={effectiveRunId} />
          ) : (
            <CardContent className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No runs to display yet.
            </CardContent>
          )}
        </Card>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: QaAutopilotRunSummary }) {
  const isRunning = run.status === "running";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          {isRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <span>{formatTimestamp(run.startedAt)}</span>
        </div>
        <Badge
          variant="outline"
          className="text-[10px] uppercase tracking-wide"
        >
          {run.trigger}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{formatDuration(run.durationMs)}</span>
        <span>· {run.passing} pass</span>
        <span>· {run.failing} fail</span>
        <span>· {run.flaky} flaky</span>
        <span>· {run.autoFixesApplied} auto-fixed</span>
        <span>· {run.needsReview} review</span>
      </div>
    </div>
  );
}

type FilterMode = "all" | "failing" | "needs-review" | "auto-fixed";

function RunDetail({ runId }: { runId: string }) {
  const detailQuery = useGetQaAutopilotRun(runId, {
    query: {
      queryKey: getGetQaAutopilotRunQueryKey(runId),
      refetchInterval: (q) =>
        q.state.data?.run.status === "running" ? 3_000 : false,
    },
  });
  const [filter, setFilter] = useState<FilterMode>("all");

  const detail = detailQuery.data;
  const findingsBySuite = useMemo(() => {
    if (!detail) return new Map<string, QaAutopilotFinding[]>();
    const map = new Map<string, QaAutopilotFinding[]>();
    for (const f of detail.findings) {
      if (filter === "failing" && f.autoFixStatus === "auto-fixed") continue;
      if (filter === "needs-review" && f.autoFixStatus !== "needs-review")
        continue;
      if (filter === "auto-fixed" && f.autoFixStatus !== "auto-fixed") continue;
      const arr = map.get(f.suiteId) ?? [];
      arr.push(f);
      map.set(f.suiteId, arr);
    }
    return map;
  }, [detail, filter]);

  const fixActionsByFinding = useMemo(() => {
    const map = new Map<string, QaAutopilotFixAction[]>();
    if (!detail) return map;
    for (const a of detail.fixActions) {
      const key = a.findingId ?? `__suite__${a.suiteId}`;
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return map;
  }, [detail]);

  if (!detail) {
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
          <CardTitle className="text-base">
            {detail.run.status === "running" ? "Running…" : "Run summary"}
          </CardTitle>
          <Badge variant="outline" className="uppercase text-[10px]">
            {detail.run.trigger}
          </Badge>
        </div>
        <CardDescription className="text-xs">
          Started {formatTimestamp(detail.run.startedAt)} ·{" "}
          {formatDuration(detail.run.durationMs)} · {detail.run.totalSuites}{" "}
          suites
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <FilterButton
            current={filter}
            value="all"
            onClick={setFilter}
            label="All"
          />
          <FilterButton
            current={filter}
            value="failing"
            onClick={setFilter}
            label="Failing"
          />
          <FilterButton
            current={filter}
            value="needs-review"
            onClick={setFilter}
            label="Needs review"
          />
          <FilterButton
            current={filter}
            value="auto-fixed"
            onClick={setFilter}
            label="Auto-fixed"
          />
        </div>
        <Separator />
        {findingsBySuite.size === 0 ? (
          <div className="rounded-md border bg-emerald-50 p-4 text-sm text-emerald-900">
            {filter === "all"
              ? detail.run.status === "running"
                ? "No findings recorded yet — autopilot is still running."
                : "No findings — every suite came back green."
              : "Nothing matches this filter."}
          </div>
        ) : (
          <ScrollArea className="h-[55vh]">
            <Accordion type="multiple" className="space-y-2">
              {[...findingsBySuite.entries()].map(([suiteId, findings]) => (
                <AccordionItem
                  key={suiteId}
                  value={suiteId}
                  className="rounded-md border"
                >
                  <AccordionTrigger className="px-3 py-2 hover:no-underline">
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="font-medium">{suiteId}</span>
                      <span className="text-xs text-muted-foreground">
                        {findings.length} finding{findings.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-3 pb-3">
                    <ul className="space-y-2">
                      {findings.map((f) => (
                        <FindingRow
                          key={f.id}
                          finding={f}
                          fixActions={
                            fixActionsByFinding.get(f.id) ??
                            fixActionsByFinding.get(`__suite__${f.suiteId}`) ??
                            []
                          }
                        />
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </ScrollArea>
        )}
      </CardContent>
    </>
  );
}

function FilterButton({
  current,
  value,
  onClick,
  label,
}: {
  current: FilterMode;
  value: FilterMode;
  onClick: (v: FilterMode) => void;
  label: string;
}) {
  return (
    <Button
      size="sm"
      variant={current === value ? "default" : "outline"}
      onClick={() => onClick(value)}
      data-testid={`autopilot-filter-${value}`}
    >
      {label}
    </Button>
  );
}

const CATEGORY_TONE: Record<QaAutopilotFindingCategory, string> = {
  flaky: "bg-amber-100 text-amber-900",
  snapshot: "bg-violet-100 text-violet-900",
  "codegen-stale": "bg-sky-100 text-sky-900",
  lint: "bg-slate-200 text-slate-800",
  fixture: "bg-orange-100 text-orange-900",
  "app-code": "bg-rose-100 text-rose-900",
  unknown: "bg-slate-100 text-slate-700",
};
const AUTOFIX_TONE: Record<QaAutopilotFindingAutoFixStatus, string> = {
  "auto-fixed": "bg-emerald-100 text-emerald-900",
  "needs-review": "bg-rose-100 text-rose-900",
  skipped: "bg-slate-100 text-slate-700",
};

function FindingRow({
  finding,
  fixActions,
}: {
  finding: QaAutopilotFinding;
  fixActions: QaAutopilotFixAction[];
}) {
  return (
    <li
      className="rounded border bg-slate-50 p-3"
      data-testid={`autopilot-finding-${finding.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={`text-[10px] uppercase ${CATEGORY_TONE[finding.category]}`}>
          {finding.category}
        </Badge>
        <Badge
          className={`text-[10px] uppercase ${AUTOFIX_TONE[finding.autoFixStatus]}`}
        >
          {finding.autoFixStatus}
        </Badge>
        {finding.testName ? (
          <span className="text-xs font-medium">{finding.testName}</span>
        ) : null}
        {finding.filePath ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {finding.filePath}
            {finding.line ? `:${finding.line}` : ""}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {finding.plainSummary}
      </div>
      <pre className="mt-2 max-h-40 overflow-auto rounded border bg-slate-950 p-2 text-[11px] text-slate-100 whitespace-pre-wrap break-words">
        {finding.errorExcerpt || "(no excerpt)"}
      </pre>
      {finding.suggestedDiff ? (
        <SuggestedDiff
          findingId={finding.id}
          diff={finding.suggestedDiff}
        />
      ) : null}
      {fixActions.length > 0 ? (
        <div className="mt-2 space-y-1">
          {fixActions.map((a) => (
            <div
              key={a.id}
              className="rounded border bg-white p-2 text-[11px]"
              data-testid={`autopilot-fix-${a.id}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {a.fixerId} · {a.success ? "succeeded" : "failed"}
                </span>
                <span className="text-muted-foreground">
                  {formatRelative(a.startedAt)}
                </span>
              </div>
              <div className="text-muted-foreground">{a.command}</div>
              {a.filesChanged.length > 0 ? (
                <div className="mt-1">
                  <span className="text-muted-foreground">Files: </span>
                  <span>{a.filesChanged.join(", ")}</span>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Read-only suggested-patch view with a "Copy patch" button.
 *
 * Safety: this component never applies the diff to disk. The patch is
 * a proposal — the user copies it and runs `git apply` themselves.
 */
function SuggestedDiff({
  findingId,
  diff,
}: {
  findingId: string;
  diff: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === "function"
      ) {
        await navigator.clipboard.writeText(diff);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = diff;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div
      className="mt-2 rounded border bg-white"
      data-testid={`autopilot-suggested-diff-${findingId}`}
    >
      <div className="flex items-center justify-between border-b px-2 py-1">
        <div className="flex items-center gap-2 text-[11px] font-medium text-slate-700">
          <Badge className="bg-emerald-100 text-emerald-900 text-[10px] uppercase">
            suggested patch
          </Badge>
          <span className="text-muted-foreground">
            proposal only — never auto-applied
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={copy}
          className="h-6 px-2 text-[11px]"
          data-testid={`autopilot-copy-diff-${findingId}`}
        >
          {copied ? (
            <>
              <Check className="mr-1 h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 h-3 w-3" /> Copy patch
            </>
          )}
        </Button>
      </div>
      <pre className="max-h-56 overflow-auto p-2 text-[11px] text-slate-900 whitespace-pre-wrap break-words">
        {diff}
      </pre>
    </div>
  );
}

function NotificationsCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const stateQuery = useGetQaAutopilotState({
    query: { queryKey: getGetQaAutopilotStateQueryKey() },
  });
  const mutation = useUpdateQaAutopilotSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "Notification settings saved" });
        void qc.invalidateQueries({
          queryKey: getGetQaAutopilotStateQueryKey(),
        });
      },
      onError: (err) =>
        toast({
          title: "Could not save settings",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        }),
    },
  });

  const persisted = stateQuery.data?.notify;
  // The webhook URL is write-only on the server (it's a bearer
  // secret), so we cannot pre-fill the input. The current value is
  // surfaced as a hint underneath instead. Any save submits the
  // current minSeverity plus whatever URL the operator typed (empty
  // disables).
  const [webhook, setWebhook] = useState("");
  const [minSeverity, setMinSeverity] =
    useState<QaAutopilotNotifyMinSeverity>(
      QaAutopilotNotifyMinSeverity.error,
    );

  useEffect(() => {
    if (!persisted) return;
    setMinSeverity(persisted.minSeverity);
  }, [persisted]);

  const dirty =
    persisted &&
    (webhook.trim().length > 0 || minSeverity !== persisted.minSeverity);

  return (
    <Card data-testid="autopilot-notify-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Notifications</CardTitle>
        <CardDescription className="text-xs">
          POST a JSON summary to a webhook (Slack, Teams, Zapier, …) when a
          sweep finishes with failing or needs-review findings. Leave the URL
          empty to disable.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="autopilot-notify-webhook" className="text-xs">
              Webhook URL{" "}
              <span className="text-muted-foreground">(write-only)</span>
            </Label>
            <Input
              id="autopilot-notify-webhook"
              data-testid="autopilot-notify-webhook"
              type="password"
              autoComplete="off"
              placeholder={
                persisted?.enabled
                  ? "Leave blank to keep current"
                  : "https://hooks.slack.com/services/…"
              }
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
            />
            <div
              className="text-[11px] text-muted-foreground"
              data-testid="autopilot-notify-hint"
            >
              {persisted?.enabled
                ? `Currently sending to ${persisted.hint ?? "(unknown)"}`
                : "Notifications are disabled."}
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Min severity</Label>
            <Select
              value={minSeverity}
              onValueChange={(v) =>
                setMinSeverity(v as QaAutopilotNotifyMinSeverity)
              }
            >
              <SelectTrigger data-testid="autopilot-notify-min-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={QaAutopilotNotifyMinSeverity.warning}>
                  Warning (any red findings)
                </SelectItem>
                <SelectItem value={QaAutopilotNotifyMinSeverity.error}>
                  Error (failing suite required)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Button
              data-testid="autopilot-notify-save"
              disabled={!dirty || mutation.isPending}
              onClick={() => {
                const trimmed = webhook.trim();
                mutation.mutate({
                  data: {
                    notify:
                      trimmed.length > 0
                        ? { webhook: trimmed, minSeverity }
                        : { minSeverity },
                  },
                });
                setWebhook("");
              }}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
            {persisted?.enabled ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="autopilot-notify-disable"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    data: { notify: { webhook: "", minSeverity } },
                  })
                }
              >
                Disable
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
