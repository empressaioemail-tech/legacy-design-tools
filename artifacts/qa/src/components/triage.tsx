/**
 * Task #503 — shared "Add to triage" UI helpers.
 *
 * This file contains:
 *  - useAddToTriage()         : POST hook + invalidates the triage list/count.
 *  - useTriageCount()         : tiny query that just reads the badge count.
 *  - <AddToTriageButton/>     : compact button that toasts on success.
 *
 * Surfaces (autopilot, run history, suite cards, checklists) all use
 * these helpers so the wire format and error UX stay in one place.
 */

import {
  useCreateQaTriageItem,
  useListQaTriageItems,
  getListQaTriageItemsQueryKey,
  type CreateQaTriageItemBody,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ListPlus, Check } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function useTriageCounts() {
  return useListQaTriageItems(undefined, {
    query: {
      queryKey: getListQaTriageItemsQueryKey(),
      refetchInterval: 15_000,
    },
  });
}

interface AddToTriageButtonProps
  extends Omit<ButtonProps, "onClick" | "children"> {
  body: CreateQaTriageItemBody;
  label?: string;
  testId?: string;
}

export function AddToTriageButton({
  body,
  label = "Add to triage",
  testId,
  className,
  size = "sm",
  variant = "outline",
  ...rest
}: AddToTriageButtonProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [justAdded, setJustAdded] = useState(false);
  const mutation = useCreateQaTriageItem({
    mutation: {
      onSuccess: () => {
        setJustAdded(true);
        setTimeout(() => setJustAdded(false), 2_000);
        void qc.invalidateQueries({
          queryKey: getListQaTriageItemsQueryKey(),
        });
        toast({ title: "Added to triage" });
      },
      onError: (err) => {
        toast({
          title: "Could not add to triage",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  return (
    <Button
      {...rest}
      size={size}
      variant={variant}
      className={cn("h-7 px-2 text-[11px]", className)}
      data-testid={testId}
      disabled={mutation.isPending || rest.disabled}
      onClick={() => mutation.mutate({ data: body })}
    >
      {justAdded ? (
        <>
          <Check className="mr-1 h-3 w-3" /> Queued
        </>
      ) : (
        <>
          <ListPlus className="mr-1 h-3 w-3" /> {label}
        </>
      )}
    </Button>
  );
}
