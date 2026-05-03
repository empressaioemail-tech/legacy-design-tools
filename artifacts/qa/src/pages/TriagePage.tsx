/**
 * Task #503 — Triage queue page.
 *
 * Three lanes (Open / Sent / Done). Each lane shows the cards that
 * status, oldest-first within the page sort. Header actions:
 *
 *  - "Push all open to planning" — POSTs /qa/triage/bundle for every
 *    open item, copies the markdown to clipboard, also offers a
 *    download, and on success bulk-moves the included items into the
 *    "sent" lane.
 *  - Each card has "Copy as prompt" (single-item bundle) and lane-move
 *    controls (open ↔ sent ↔ done).
 *
 * The bundle endpoint is read-only — it does not mutate state — so the
 * client is in charge of moving items into "sent" only after the copy
 * succeeded. This keeps the lane state honest if clipboard access
 * fails.
 */

import { useMemo, useState } from "react";
import {
  useListQaTriageItems,
  useUpdateQaTriageItem,
  useBulkUpdateQaTriageItems,
  useDeleteQaTriageItem,
  useBundleQaTriageItems,
  getListQaTriageItemsQueryKey,
  type QaTriageItem,
  type QaTriageStatus,
  type QaTriageSeverity,
  type QaTriageSourceKind,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { formatRelative } from "@/lib/format";
import { Copy, Send, CheckCircle2, Trash2, RotateCcw, ExternalLink } from "lucide-react";
import { Link } from "wouter";

const SOURCE_LABEL: Record<QaTriageSourceKind, string> = {
  autopilot_finding: "Autopilot",
  run: "Run history",
  suite_failure: "Suite",
  checklist_item: "Checklist",
};

const SEVERITY_TONE: Record<QaTriageSeverity, string> = {
  info: "bg-slate-100 text-slate-700",
  warning: "bg-amber-100 text-amber-900",
  error: "bg-rose-100 text-rose-900",
};

const LANES: Array<{ status: QaTriageStatus; label: string; description: string }> = [
  {
    status: "open",
    label: "Open",
    description: "Failures waiting to be sent to planning.",
  },
  {
    status: "sent",
    label: "Sent",
    description: "Already forwarded — waiting on a fix.",
  },
  {
    status: "done",
    label: "Done",
    description: "Resolved or rejected. Kept for audit.",
  },
];

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    }
  } catch {
    return false;
  }
  return false;
}

function downloadMarkdown(filename: string, body: string) {
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function TriagePage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const listQuery = useListQaTriageItems(undefined, {
    query: {
      queryKey: getListQaTriageItemsQueryKey(),
      refetchInterval: 10_000,
    },
  });

  const items = listQuery.data?.items ?? [];
  const counts = listQuery.data?.counts ?? { open: 0, sent: 0, done: 0, total: 0 };

  const itemsByLane = useMemo(() => {
    const byLane: Record<QaTriageStatus, QaTriageItem[]> = {
      open: [],
      sent: [],
      done: [],
    };
    for (const it of items) byLane[it.status as QaTriageStatus].push(it);
    return byLane;
  }, [items]);

  const updateMutation = useUpdateQaTriageItem({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListQaTriageItemsQueryKey() });
      },
    },
  });
  const bulkMutation = useBulkUpdateQaTriageItems({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListQaTriageItemsQueryKey() });
      },
    },
  });
  const deleteMutation = useDeleteQaTriageItem({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListQaTriageItemsQueryKey() });
      },
    },
  });
  const bundleMutation = useBundleQaTriageItems();

  const [pushing, setPushing] = useState(false);

  async function pushAllOpen() {
    if (counts.open === 0) {
      toast({ title: "Nothing to push", description: "No open items right now." });
      return;
    }
    setPushing(true);
    try {
      const result = await bundleMutation.mutateAsync({ data: {} });
      const copied = await copyToClipboard(result.markdown);
      const filename = `qa-triage-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`;
      downloadMarkdown(filename, result.markdown);
      const ids = result.items.map((i) => i.id);
      if (ids.length > 0) {
        await bulkMutation.mutateAsync({ data: { ids, status: "sent" } });
      }
      toast({
        title: copied ? "Copied + downloaded" : "Downloaded (copy failed)",
        description: `${result.count} item${result.count === 1 ? "" : "s"} moved to Sent.`,
      });
    } catch (err) {
      toast({
        title: "Push failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setPushing(false);
    }
  }

  async function copyAsPrompt(item: QaTriageItem) {
    try {
      const result = await bundleMutation.mutateAsync({
        data: { ids: [item.id] },
      });
      const ok = await copyToClipboard(result.markdown);
      toast({
        title: ok ? "Copied prompt" : "Copy failed",
        description: ok ? undefined : "Use the download button instead.",
        variant: ok ? "default" : "destructive",
      });
    } catch (err) {
      toast({
        title: "Could not render prompt",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-4" data-testid="triage-page">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Triage queue</h2>
          <p className="text-sm text-muted-foreground">
            Pinned QA failures forwarded from autopilot, run history, suites,
            and manual checklists. Use "Push all open" to bundle them into a
            single brief for planning.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
            data-testid="triage-refresh"
          >
            <RotateCcw
              className={`mr-2 h-4 w-4 ${listQuery.isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={pushAllOpen}
            disabled={pushing || counts.open === 0}
            data-testid="triage-push-all"
          >
            <Send className="mr-2 h-4 w-4" />
            {pushing ? "Pushing…" : `Push all open (${counts.open})`}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {LANES.map((lane) => (
          <Card key={lane.status} data-testid={`triage-lane-${lane.status}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base capitalize">{lane.label}</CardTitle>
                <Badge variant="outline">
                  {counts[lane.status]} item{counts[lane.status] === 1 ? "" : "s"}
                </Badge>
              </div>
              <CardDescription className="text-xs">
                {lane.description}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[60vh]">
                {itemsByLane[lane.status].length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    {lane.status === "open"
                      ? "Nothing waiting — adds from suites, run history, autopilot, and checklists land here."
                      : `No ${lane.label.toLowerCase()} items.`}
                  </div>
                ) : (
                  <ul className="divide-y">
                    {itemsByLane[lane.status].map((item) => (
                      <TriageCard
                        key={item.id}
                        item={item}
                        onMove={(status) =>
                          updateMutation.mutate({
                            id: item.id,
                            data: { status },
                          })
                        }
                        onDelete={() =>
                          deleteMutation.mutate({ id: item.id })
                        }
                        onCopy={() => copyAsPrompt(item)}
                      />
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function sourceLinkFor(item: QaTriageItem): { to: string; label: string } | null {
  switch (item.sourceKind as QaTriageSourceKind) {
    case "autopilot_finding":
      return item.sourceRunId
        ? { to: `/autopilot?run=${encodeURIComponent(item.sourceRunId)}`, label: "Open in Autopilot" }
        : { to: "/autopilot", label: "Open Autopilot" };
    case "run":
      return { to: `/history?run=${encodeURIComponent(item.sourceId)}`, label: "Open in Run history" };
    case "suite_failure":
      return { to: `/?suite=${encodeURIComponent(item.sourceId)}`, label: "Open suite" };
    case "checklist_item": {
      const checklistId = item.sourceId.split("/")[0] ?? item.sourceId;
      return {
        to: `/checklists?checklist=${encodeURIComponent(checklistId)}`,
        label: "Open checklist",
      };
    }
    default:
      return null;
  }
}

function SourceLink({ item }: { item: QaTriageItem }) {
  const link = sourceLinkFor(item);
  if (!link) return null;
  return (
    <Link
      href={link.to}
      data-testid={`triage-source-link-${item.id}`}
      className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:underline"
    >
      <ExternalLink className="h-3 w-3" />
      {link.label}
    </Link>
  );
}

function TriageCard({
  item,
  onMove,
  onDelete,
  onCopy,
}: {
  item: QaTriageItem;
  onMove: (status: QaTriageStatus) => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  return (
    <li className="space-y-2 p-3" data-testid={`triage-item-${item.id}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="text-[10px] uppercase tracking-wide"
        >
          {SOURCE_LABEL[item.sourceKind as QaTriageSourceKind]}
        </Badge>
        <Badge
          className={`text-[10px] uppercase ${SEVERITY_TONE[item.severity as QaTriageSeverity]}`}
        >
          {item.severity}
        </Badge>
        {item.suiteId ? (
          <span className="text-[11px] text-muted-foreground">
            {item.suiteId}
          </span>
        ) : null}
        <span className="ml-auto text-[11px] text-muted-foreground">
          {formatRelative(item.createdAt)}
        </span>
      </div>
      <div className="text-sm font-medium leading-snug">{item.title}</div>
      <SourceLink item={item} />
      {item.excerpt ? (
        <pre className="max-h-24 overflow-auto rounded border bg-slate-950 p-2 text-[11px] text-slate-100 whitespace-pre-wrap break-words">
          {item.excerpt}
        </pre>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={onCopy}
          data-testid={`triage-copy-${item.id}`}
        >
          <Copy className="mr-1 h-3 w-3" /> Copy as prompt
        </Button>
        {item.status !== "open" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onMove("open")}
            data-testid={`triage-reopen-${item.id}`}
          >
            <RotateCcw className="mr-1 h-3 w-3" /> Reopen
          </Button>
        ) : null}
        {item.status !== "sent" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onMove("sent")}
            data-testid={`triage-mark-sent-${item.id}`}
          >
            <Send className="mr-1 h-3 w-3" /> Mark sent
          </Button>
        ) : null}
        {item.status !== "done" ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => onMove("done")}
            data-testid={`triage-mark-done-${item.id}`}
          >
            <CheckCircle2 className="mr-1 h-3 w-3" /> Done
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-7 px-2 text-[11px] text-rose-700 hover:text-rose-900"
          onClick={onDelete}
          data-testid={`triage-delete-${item.id}`}
        >
          <Trash2 className="mr-1 h-3 w-3" /> Delete
        </Button>
      </div>
    </li>
  );
}
