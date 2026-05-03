/**
 * CommunicateComposer — PLR-5 / Task #476.
 *
 * Modal that opens when the reviewer clicks Communicate on the
 * SubmissionDetailModal. Calls the server-side
 * `POST /submissions/:id/communications/draft` endpoint, which
 * assembles the deterministic comment-letter skeleton from open
 * findings (`@workspace/comment-letter.assembleCommentLetter`) and
 * runs it through an Anthropic polish pass before returning. The
 * polished body is loaded into an editable textarea so the reviewer
 * can refine it and Send via `useCreateSubmissionCommunication`.
 *
 * The skeleton groups by discipline (the `category` enum) and then
 * by page label (the BIM `elementRef` when present, else "General");
 * inline `[[CODE:...]]` and `{{atom|briefing-source|...}}` citation
 * tokens are validated server-side to flow through the polish step
 * unchanged so a downstream renderer can re-link them. If the polish
 * fails the deterministic skeleton is returned as a safe fallback
 * (`polished: false` + a structured `fallbackReason`).
 *
 * Email dispatch is NOT part of this composer: the api-server has
 * no outbound-mail pipeline yet, so the route layer logs the
 * recipient list and persists it for a future dispatcher.
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  draftSubmissionCommunication,
  getListSubmissionCommunicationsQueryKey,
  useCreateSubmissionCommunication,
  type DraftSubmissionCommunicationResponse,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface CommunicateComposerProps {
  open: boolean;
  onClose: () => void;
  submissionId: string;
  /**
   * Retained for API compatibility with the call site — the server
   * endpoint now resolves these from the engagement row directly so
   * the deterministic skeleton, audit log, and reviewer's view all
   * agree on a single source of truth.
   */
  jurisdictionLabel?: string;
  applicantFirm?: string | null;
  submittedAt?: string;
}

const DRAFT_FALLBACK_LABELS: Record<string, string> = {
  no_open_findings: "No open findings — using the standard no-comments letter.",
  empty_completion:
    "The polish step returned an empty draft, so we fell back to the deterministic skeleton.",
  missing_citations:
    "The polish step dropped a code citation, so we fell back to the deterministic skeleton to keep the audit trail intact.",
  completer_error:
    "The polish service is unavailable right now, so we fell back to the deterministic skeleton.",
};

function draftQueryKey(submissionId: string): readonly unknown[] {
  return ["communicate-draft", submissionId];
}

export function CommunicateComposer({
  open,
  onClose,
  submissionId,
}: CommunicateComposerProps) {
  // The polished draft endpoint is a POST (it does real work — Anthropic
  // round-trip) but it's idempotent and reviewer-only, so we drive it
  // through useQuery for the loading-state plumbing react-query gives us
  // for free. The query is gated on `enabled: open` so closing + reopening
  // the modal kicks a fresh polish (the open findings may have changed).
  const draftQuery = useQuery<DraftSubmissionCommunicationResponse>({
    queryKey: draftQueryKey(submissionId),
    queryFn: () => draftSubmissionCommunication(submissionId),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const draft = draftQuery.data;

  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-seed editor when the draft arrives (or refreshes) — but only
  // while the reviewer hasn't started editing, so we don't blow away
  // in-progress edits if the polish call resolves late.
  useEffect(() => {
    if (!draft) return;
    if (!dirty) {
      setSubject(draft.subject);
      setBody(draft.body);
    }
  }, [draft, dirty]);

  // Reset dirty + error state every time the modal is closed so the
  // next open re-seeds from scratch.
  useEffect(() => {
    if (!open) {
      setDirty(false);
      setErrorMessage(null);
      setSubject("");
      setBody("");
    }
  }, [open]);

  const qc = useQueryClient();
  const sendMutation = useCreateSubmissionCommunication({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({
          queryKey: getListSubmissionCommunicationsQueryKey(submissionId),
        });
        onClose();
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Failed to send comment letter.";
        setErrorMessage(msg);
      },
    },
  });

  const handleSend = () => {
    if (!draft) return;
    setErrorMessage(null);
    sendMutation.mutate({
      submissionId,
      data: {
        subject: subject.trim(),
        body: body.trim() + "\n",
        // The audited atom-id snapshot is the server's view at draft
        // time — forwarding it verbatim keeps the reviewer's "what was
        // sent" record locked to the same finding set the polish saw.
        findingAtomIds: draft.findingAtomIds,
        // No architect-of-record contact is captured on the
        // engagement today; the route logs the empty list and
        // persists it for a future dispatcher to pick up.
        recipientUserIds: [],
      },
    });
  };

  const sending = sendMutation.isPending;
  const drafting = draftQuery.isPending && open;
  const draftLoadFailed = draftQuery.isError;
  const canSend =
    !sending &&
    !drafting &&
    !!draft &&
    subject.trim().length > 0 &&
    body.trim().length > 0;
  const findingCount = draft?.findingCount ?? 0;
  const polishedNote =
    draft && !draft.polished && draft.fallbackReason
      ? DRAFT_FALLBACK_LABELS[draft.fallbackReason] ?? null
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !sending) onClose();
      }}
    >
      <DialogContent
        data-testid="communicate-composer"
        className="max-w-3xl"
        style={{ maxHeight: "90vh", overflow: "auto" }}
      >
        <DialogHeader>
          <DialogTitle>Comment letter</DialogTitle>
          <DialogDescription>
            {drafting
              ? "Polishing the AI-drafted letter…"
              : draftLoadFailed
                ? "We couldn't generate a draft. Try again in a moment."
                : `AI-drafted from ${findingCount} ${
                    findingCount === 1 ? "open finding" : "open findings"
                  }. Review and edit before sending.`}
          </DialogDescription>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {polishedNote && (
            <div
              data-testid="communicate-composer-polish-note"
              style={{
                fontSize: 12,
                color: "var(--muted-foreground)",
                background: "var(--muted, #f3f4f6)",
                borderRadius: 6,
                padding: "6px 8px",
              }}
            >
              {polishedNote}
            </div>
          )}
          <div>
            <Label htmlFor="communicate-subject">Subject</Label>
            <Input
              id="communicate-subject"
              data-testid="communicate-composer-subject"
              value={subject}
              onChange={(e) => {
                setDirty(true);
                setSubject(e.target.value);
              }}
              disabled={sending || drafting}
            />
          </div>
          <div>
            <Label htmlFor="communicate-body">Body</Label>
            <Textarea
              id="communicate-body"
              data-testid="communicate-composer-body"
              value={drafting ? "Polishing the draft…" : body}
              onChange={(e) => {
                setDirty(true);
                setBody(e.target.value);
              }}
              rows={20}
              disabled={sending || drafting}
              style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
            />
          </div>
          <div
            data-testid="communicate-composer-recipients"
            style={{ fontSize: 12, color: "var(--muted-foreground)" }}
          >
            No architect-of-record contact has been captured for this
            engagement; the letter will be persisted for the audit trail
            and routed once an outbound dispatcher is wired up.
          </div>
          {errorMessage && (
            <div
              data-testid="communicate-composer-error"
              role="alert"
              style={{ color: "var(--destructive, #b91c1c)", fontSize: 13 }}
            >
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={sending}
            data-testid="communicate-composer-cancel"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSend}
            disabled={!canSend}
            data-testid="communicate-composer-send"
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
