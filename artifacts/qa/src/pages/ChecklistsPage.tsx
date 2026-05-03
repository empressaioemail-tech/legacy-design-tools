import { useState } from "react";
import {
  useListQaChecklists,
  useUpdateQaChecklistItem,
  useResetQaChecklist,
  getListQaChecklistsQueryKey,
  type QaChecklistItemStatus,
  type QaChecklistSummary,
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
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { ChecklistStatusBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";
import { Check, X, MinusCircle, RotateCcw } from "lucide-react";
import { AddToTriageButton } from "@/components/triage";
import {
  useCreateQaTriageItem,
  getListQaTriageItemsQueryKey,
} from "@workspace/api-client-react";

export default function ChecklistsPage() {
  const checklistsQuery = useListQaChecklists();
  const checklists = checklistsQuery.data?.checklists ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Manual checklists</h2>
        <p className="text-sm text-muted-foreground">
          Walk through the smoke checks for each app and mark each step pass / fail / skip.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {checklists.map((c) => (
          <ChecklistCard key={c.id} checklist={c} />
        ))}
      </div>
    </div>
  );
}

function ChecklistCard({ checklist }: { checklist: QaChecklistSummary }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const updateMutation = useUpdateQaChecklistItem({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListQaChecklistsQueryKey() });
      },
      onError: (err: unknown) => {
        toast({
          title: "Could not save",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const resetMutation = useResetQaChecklist({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListQaChecklistsQueryKey() });
      },
    },
  });

  const setStatus = (
    itemId: string,
    status: QaChecklistItemStatus | null,
    note: string | null,
  ) => {
    updateMutation.mutate({
      checklistId: checklist.id,
      itemId,
      data: { status, note },
    });
  };

  return (
    <Card data-testid={`card-checklist-${checklist.id}`} className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{checklist.title}</CardTitle>
            <CardDescription className="text-xs">{checklist.description}</CardDescription>
          </div>
          <Badge variant="outline" className="text-[10px] uppercase">
            {checklist.app}
          </Badge>
        </div>
        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
            {checklist.counts.passed} pass
          </Badge>
          <Badge className="bg-rose-100 text-rose-800 hover:bg-rose-100">
            {checklist.counts.failed} fail
          </Badge>
          <Badge className="bg-slate-200 text-slate-800 hover:bg-slate-200">
            {checklist.counts.skipped} skip
          </Badge>
          <Badge variant="outline">{checklist.counts.notRun} not run</Badge>
          <div className="ml-auto flex items-center gap-1">
            <AddFailingToTriageButton checklist={checklist} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                resetMutation.mutate({ checklistId: checklist.id })
              }
              disabled={resetMutation.isPending}
              data-testid={`button-reset-${checklist.id}`}
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Reset
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 flex-1">
        {checklist.items.map((item, idx) => (
          <div key={item.id}>
            {idx > 0 ? <Separator className="my-3" /> : null}
            <ChecklistRow
              checklistId={checklist.id}
              item={item}
              onSetStatus={(status, note) => setStatus(item.id, status, note)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AddFailingToTriageButton({ checklist }: { checklist: QaChecklistSummary }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const mutation = useCreateQaTriageItem();
  const failing = checklist.items.filter((i) => i.status === "fail");
  if (failing.length === 0) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid={`button-checklist-triage-failing-${checklist.id}`}
      disabled={mutation.isPending}
      onClick={async () => {
        try {
          for (const item of failing) {
            await mutation.mutateAsync({
              data: {
                sourceKind: "checklist_item",
                sourceId: `${checklist.id}/${item.id}`,
                suiteId: checklist.id,
                title: `${checklist.id} — ${item.label}`,
                severity: "error",
                excerpt: item.note ?? "",
                suggestedNextStep:
                  item.hint ?? "Investigate the failing manual check.",
              },
            });
          }
          await qc.invalidateQueries({
            queryKey: getListQaTriageItemsQueryKey(),
          });
          toast({
            title: `Added ${failing.length} failing item${failing.length === 1 ? "" : "s"} to triage`,
          });
        } catch (err) {
          toast({
            title: "Could not add to triage",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        }
      }}
    >
      Add failing to triage ({failing.length})
    </Button>
  );
}

function ChecklistRow({
  checklistId,
  item,
  onSetStatus,
}: {
  checklistId: string;
  item: QaChecklistSummary["items"][number];
  onSetStatus: (
    status: QaChecklistItemStatus | null,
    note: string | null,
  ) => void;
}) {
  const [localNote, setLocalNote] = useState(item.note ?? "");
  const [editing, setEditing] = useState(false);

  return (
    <div data-testid={`row-${checklistId}-${item.id}`} className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 space-y-1">
          <div className="text-sm font-medium leading-snug">{item.label}</div>
          {item.hint ? (
            <div className="text-xs text-muted-foreground">{item.hint}</div>
          ) : null}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <ChecklistStatusBadge status={item.status} />
            {item.updatedAt ? <span>updated {formatRelative(item.updatedAt)}</span> : null}
          </div>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant={item.status === "pass" ? "default" : "outline"}
            className="h-7 w-7"
            onClick={() => onSetStatus("pass", item.note ?? null)}
            data-testid={`button-pass-${checklistId}-${item.id}`}
            title="Pass"
          >
            <Check className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant={item.status === "fail" ? "destructive" : "outline"}
            className="h-7 w-7"
            onClick={() => onSetStatus("fail", item.note ?? null)}
            data-testid={`button-fail-${checklistId}-${item.id}`}
            title="Fail"
          >
            <X className="h-4 w-4" />
          </Button>
          <Button
            size="icon"
            variant={item.status === "skip" ? "secondary" : "outline"}
            className="h-7 w-7"
            onClick={() => onSetStatus("skip", item.note ?? null)}
            data-testid={`button-skip-${checklistId}-${item.id}`}
            title="Skip"
          >
            <MinusCircle className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {item.status === "fail" ? (
        <div>
          <AddToTriageButton
            testId={`checklist-triage-${checklistId}-${item.id}`}
            label="Add to triage"
            body={{
              sourceKind: "checklist_item",
              sourceId: `${checklistId}/${item.id}`,
              suiteId: checklistId,
              title: `${checklistId} — ${item.label}`,
              severity: "error",
              excerpt: item.note ?? "",
              suggestedNextStep:
                item.hint ?? "Investigate the failing manual check.",
            }}
          />
        </div>
      ) : null}
      {editing ? (
        <div className="space-y-2">
          <Textarea
            value={localNote}
            onChange={(e) => setLocalNote(e.target.value)}
            placeholder="Notes…"
            className="text-xs"
            rows={3}
            data-testid={`note-${checklistId}-${item.id}`}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                onSetStatus(item.status, localNote.trim() ? localNote : null);
                setEditing(false);
              }}
              data-testid={`button-save-note-${checklistId}-${item.id}`}
            >
              Save note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setLocalNote(item.note ?? "");
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          {item.note ? (
            <p className="text-xs text-foreground/80 italic flex-1">{item.note}</p>
          ) : (
            <span className="text-xs text-muted-foreground italic flex-1">No notes</span>
          )}
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setEditing(true)}
            data-testid={`button-edit-note-${checklistId}-${item.id}`}
          >
            {item.note ? "Edit" : "Add note"}
          </Button>
        </div>
      )}
    </div>
  );
}
