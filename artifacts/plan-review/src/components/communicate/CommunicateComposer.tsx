/**
 * CommunicateComposer — PLR-5.
 *
 * Modal that opens when the reviewer clicks Communicate on the
 * SubmissionDetailModal. Assembles an AI-drafted comment letter
 * (subject + markdown body) from the submission's open findings via
 * `@workspace/comment-letter`, lets the reviewer edit, and on Send
 * persists a `submission_communications` row through the generated
 * `useCreateSubmissionCommunication` hook.
 *
 * The body of this draft is grouped by discipline (the `category`
 * enum) and then by page label (the BIM `elementRef` when present,
 * else "General"); inline `[[CODE:...]]` and
 * `{{atom|briefing-source|...}}` citation tokens flow through
 * unchanged so a downstream renderer can re-link them.
 *
 * Email dispatch is NOT part of this composer: the api-server has
 * no outbound-mail pipeline yet, so the route layer logs the
 * recipient list and persists it for a future dispatcher.
 */

import { useEffect, useMemo, useState } from "react";
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
  getListSubmissionCommunicationsQueryKey,
  useCreateSubmissionCommunication,
} from "@workspace/api-client-react";
import {
  assembleCommentLetter,
  type CommentLetterFinding,
} from "@workspace/comment-letter";
import { useQueryClient } from "@tanstack/react-query";
import { useListSubmissionFindings } from "../../lib/findingsApi";

export interface CommunicateComposerProps {
  open: boolean;
  onClose: () => void;
  submissionId: string;
  jurisdictionLabel: string;
  applicantFirm: string | null;
  submittedAt: string;
}

export function CommunicateComposer({
  open,
  onClose,
  submissionId,
  jurisdictionLabel,
  applicantFirm,
  submittedAt,
}: CommunicateComposerProps) {
  const findingsQuery = useListSubmissionFindings(submissionId);
  const findings: CommentLetterFinding[] = useMemo(
    () =>
      (findingsQuery.data ?? []).map((f) => ({
        id: f.id,
        severity: f.severity,
        category: f.category,
        status: f.status,
        text: f.text,
        elementRef: f.elementRef ?? null,
      })),
    [findingsQuery.data],
  );

  const draft = useMemo(
    () =>
      assembleCommentLetter({
        findings,
        context: { jurisdictionLabel, applicantFirm, submittedAt },
      }),
    [findings, jurisdictionLabel, applicantFirm, submittedAt],
  );

  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [dirty, setDirty] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Re-seed editor when the draft changes (e.g. findings finished
  // loading after the modal opened) — but only while the reviewer
  // hasn't started editing, so we don't blow away in-progress edits.
  useEffect(() => {
    if (!dirty) {
      setSubject(draft.subject);
      setBody(draft.body);
    }
  }, [draft.subject, draft.body, dirty]);

  // Reset dirty + error state every time the modal is closed so the
  // next open re-seeds from scratch.
  useEffect(() => {
    if (!open) {
      setDirty(false);
      setErrorMessage(null);
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

  const findingAtomIds = useMemo(
    () =>
      findings
        .filter((f) => f.status === "ai-produced" || f.status === "accepted")
        .map((f) => f.id),
    [findings],
  );

  const handleSend = () => {
    setErrorMessage(null);
    sendMutation.mutate({
      submissionId,
      data: {
        subject: subject.trim(),
        body: body.trim() + "\n",
        findingAtomIds,
        // No architect-of-record contact is captured on the
        // engagement today; the route logs the empty list and
        // persists it for a future dispatcher to pick up.
        recipientUserIds: [],
      },
    });
  };

  const sending = sendMutation.isPending;
  const canSend =
    !sending && subject.trim().length > 0 && body.trim().length > 0;

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
            AI-drafted from {draft.findingCount}{" "}
            {draft.findingCount === 1 ? "open finding" : "open findings"}.
            Review and edit before sending.
          </DialogDescription>
        </DialogHeader>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
              disabled={sending}
            />
          </div>
          <div>
            <Label htmlFor="communicate-body">Body</Label>
            <Textarea
              id="communicate-body"
              data-testid="communicate-composer-body"
              value={body}
              onChange={(e) => {
                setDirty(true);
                setBody(e.target.value);
              }}
              rows={20}
              disabled={sending}
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
