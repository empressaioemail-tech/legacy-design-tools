import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  QaRunStatus,
  QaChecklistItemStatus,
} from "@workspace/api-client-react";

const RUN_STATUS_CLASS: Record<QaRunStatus, string> = {
  running: "bg-blue-100 text-blue-800 hover:bg-blue-100",
  passed: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  failed: "bg-rose-100 text-rose-800 hover:bg-rose-100",
  errored: "bg-amber-100 text-amber-900 hover:bg-amber-100",
};

export function RunStatusBadge({ status }: { status: QaRunStatus | null }) {
  if (!status) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        no runs yet
      </Badge>
    );
  }
  return (
    <Badge className={cn("uppercase text-[10px] tracking-wide", RUN_STATUS_CLASS[status])}>
      {status}
    </Badge>
  );
}

const ITEM_STATUS_CLASS: Record<QaChecklistItemStatus, string> = {
  pass: "bg-emerald-100 text-emerald-800 hover:bg-emerald-100",
  fail: "bg-rose-100 text-rose-800 hover:bg-rose-100",
  skip: "bg-slate-200 text-slate-800 hover:bg-slate-200",
};

export function ChecklistStatusBadge({
  status,
}: {
  status: QaChecklistItemStatus | null;
}) {
  if (!status) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        not run
      </Badge>
    );
  }
  return (
    <Badge className={cn("uppercase text-[10px] tracking-wide", ITEM_STATUS_CLASS[status])}>
      {status}
    </Badge>
  );
}
