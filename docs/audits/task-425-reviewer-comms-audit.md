# Task #425 — Reviewer comms audit (A19 / A20)

User stories:
- **A19** — architect sees reviewer comments and replies inline
- **A20** — architect is notified of status changes via email + in-app

Both were listed as "CHECK — may already work". This note records what
actually works today, what small gap was fixed in this task, and what
should be raised as a separate follow-up.

## A19 — replies inline

### What works today

- The shared `ReviewerComment` collapsible (>280 char / >4 line clamp
  with Show more / Show less) is the canonical surface for rendering a
  jurisdiction reviewer's comment. Lives at
  `lib/portal-ui/src/components/ReviewerComment.tsx:59` and is
  exercised by `lib/portal-ui/src/components/ReviewerComment.test.tsx`
  plus the consumer-level mirror at
  `artifacts/design-tools/src/components/__tests__/ReviewerComment.test.tsx`.
- The architect's row-level submissions list renders the reviewer's
  comment inline whenever the submission has a recorded response —
  `artifacts/design-tools/src/pages/EngagementDetail.tsx:3551-3556`.
- `RecordSubmissionResponseDialog`
  (`artifacts/design-tools/src/components/RecordSubmissionResponseDialog.tsx`)
  is the architect surface that captures / updates the reviewer's
  comment when the architect is backfilling an offline reply.
- `ReviewerRequestsStrip`
  (`artifacts/design-tools/src/components/ReviewerRequestsStrip.tsx:61`)
  surfaces reviewer-initiated requests (refresh briefing-source /
  refresh BIM model / regenerate briefing) above the engagement tabs;
  the architect can dismiss with a reason via
  `DismissReviewerRequestDialog.tsx`. That dismiss reason is the only
  "reply"-shaped affordance the architect has today.
- The reviewer-side threaded scratch-note panel is fully built —
  `lib/portal-ui/src/components/ReviewerAnnotationPanel.tsx` plus the
  affordance at
  `lib/portal-ui/src/components/ReviewerAnnotationAffordance.tsx` —
  but it is reviewer-only by audience gate (`audience === "internal"`)
  and the underlying
  `artifacts/api-server/src/routes/reviewerAnnotations.ts` route 403s a
  non-reviewer caller, so architects never see it.

### Small gap fixed in this task

`SubmissionDetailModal.tsx` (the per-submission detail surface opened
when the architect clicks a row in the Submissions tab) had access to
`typed.reviewerComment` on its atom payload but did **not render it**
anywhere. The architect saw their own outgoing note plus a status
timeline, and the reviewer's reply silently disappeared. Closing this
gap is in scope for this audit (label + new section in the existing
modal):

- Added a `REVIEWER COMMENT` section to
  `artifacts/design-tools/src/components/SubmissionDetailModal.tsx`
  that renders the shared `ReviewerComment` (so the >280 char / >4
  line collapsible toggle behaves identically to the row-level
  surface) and surfaces the relative "Responded …" timestamp the row
  shows.
- Section is render-or-omit — an as-yet-unanswered submission shows
  no empty placeholder, matching the contract the row-level surface
  already follows.
- New tests in
  `artifacts/design-tools/src/components/__tests__/SubmissionDetailModal.test.tsx`
  pin both the populated and absent cases.

### Larger follow-up (not done here)

A true inline reply box for the architect to post a reply back to a
reviewer comment is **larger than ½ day**:

- The reviewer-annotation route is audience-gated to `internal` and
  the annotation panel hides itself for any other audience.
  Widening this to architect-side requires a backend audience
  decision (do architects post into the same threaded scratch-note
  table, or a sibling architect-reply table?), an OpenAPI contract
  change, and an architect-flavored panel UI — all out of scope for
  an audit task.

## A20 — status notifications (email + in-app)

### What works today

- `ReviewerRequestsStrip` is the only proactive in-app surface — it
  refetches on window focus
  (`ReviewerRequestsStrip.tsx:73`) so a request the reviewer files
  while the architect is on another tab shows up the next time the
  tab regains focus.
- Toast infrastructure exists for direct-action feedback —
  `artifacts/design-tools/src/hooks/use-toast.ts:171` and
  `artifacts/design-tools/src/components/ui/toaster.tsx`. It is
  currently scoped to operation-failure feedback (geocoding,
  list-engagements failures) and is not wired to background status
  changes.
- Status changes are durably recorded —
  `submission.status-changed` events are appended in
  `artifacts/api-server/src/lib/engagementEvents.ts:388` and surface
  on the architect's `STATUS HISTORY` timeline inside
  `SubmissionDetailModal` once the architect navigates there.
- The `users` table has an `email` column
  (`artifacts/api-server/src/routes/me.ts:131`) used today only for
  timeline actor labels and stakeholder PDFs.

### Larger follow-up (not done here)

The task scope explicitly excludes "Building a brand new notifications
center or email template system." Both of A20's missing pieces are
exactly that:

1. **No email-send pipeline.** There is no SMTP / Resend / SendGrid /
   SES integration in `api-server`. Every status-change route emits a
   durable event but nothing flips that event into outbound mail.
2. **No global in-app notification surface.** No notification center,
   no unread badge in the side nav, no toast on background status
   changes, no websocket / SSE for proactive push. React Query's
   `refetchOnWindowFocus` covers the reviewer-requests strip alone.

Both of these are a multi-task lift (DB schema for notifications,
delivery worker / email provider integration, settings UI for opt-in,
notification-center component, badge wiring across the side nav) and
should land as their own tasks rather than being shoehorned into this
audit.

### Per-story verdict

| Story | Verdict |
| --- | --- |
| A19 | **Mostly works**, small gap fixed here (REVIEWER COMMENT section in SubmissionDetailModal). True architect-side reply UI is a larger follow-up. |
| A20 | **Partially works** (status changes are recorded and the reviewer-requests strip is proactive). Email and a global notification center are explicit follow-ups. |
