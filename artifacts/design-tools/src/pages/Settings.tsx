import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useGetUser,
  useUpdateMyArchitectPdfHeader,
  useUpdateMyProfile,
  getGetUserQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";

/**
 * Architect-facing Settings.
 *
 * Two self-edit forms today, each shaped like the original PDF-header
 * form (single-input + single Save button + inline status note):
 *
 *   1. Display name + email (`PATCH /me/profile`) — Task #366. The
 *      only other surface that can write these columns is the admin
 *      `PATCH /users/{id}` route, which requires the `users:manage`
 *      claim — architects don't have it. Without this form an
 *      architect is stuck with whatever opaque user id was backfilled
 *      on first sign-in.
 *
 *   2. Stakeholder briefing PDF header (`PATCH /me/architect-pdf-header`)
 *      — DA-PI-6 / Task #322. Empty / whitespace-only input clears the
 *      override server-side, so the PDF route falls back to
 *      "SmartCity Design Tools — Pre-Design Briefing".
 *
 *      The form intentionally has a single Save button — submitting
 *      an empty / whitespace-only value clears the override server-
 *      side, so the architect never has to think about a separate
 *      "reset" action.
 *
 *      Task #365 — A live mini-preview underneath the input mirrors
 *      the PDF header's typography (font stack, size, colour) and the
 *      left-aligned `@top-left` positioning the renderer uses, so the
 *      architect can iterate on wording (truncation, ampersands,
 *      em-dashes) without round-tripping through a real export. When
 *      the input is empty / whitespace-only, the preview shows the
 *      platform default in a muted style so the fallback contract is
 *      visible at a glance.
 *
 * Both forms read the same `users` row through `useGetUser`, so a
 * successful save on either form refreshes the cached profile and the
 * other form will pick up any changes on its next render.
 */

/**
 * Mirrors `DEFAULT_BRIEFING_PDF_HEADER` in
 * `artifacts/api-server/src/lib/briefingHtml.ts` — the renderer's
 * source of truth for the empty-override fallback. Inlined here
 * because the design-tools artifact can't import from api-server, and
 * this string is small enough that the duplicate-with-pointer is
 * cheaper than spinning up a shared lib for a single constant. If the
 * default ever changes, update both locations together — the
 * Settings unit test pins the preview text so the duplicate can't
 * silently drift.
 */
const DEFAULT_BRIEFING_PDF_HEADER =
  "SmartCity Design Tools — Pre-Design Briefing";

export function Settings() {
  const { data: session, isLoading: sessionLoading } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });

  const requestor = session?.requestor;
  const isUserSession = requestor?.kind === "user";
  const userId = isUserSession ? requestor.id : "";

  const {
    data: user,
    isLoading: userLoading,
    error: userError,
  } = useGetUser(userId, {
    query: {
      queryKey: getGetUserQueryKey(userId),
      // The hook is only meaningful once we know which user we're
      // editing — the generated `enabled: !!id` guard already covers
      // the empty-string case, but the explicit gate documents intent.
      enabled: isUserSession && userId.length > 0,
    },
  });

  if (sessionLoading) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl mb-6">Settings</h1>
        <div className="sc-card p-6 sc-body">Loading…</div>
      </div>
    );
  }

  if (!isUserSession) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <h1 className="text-2xl mb-6">Settings</h1>
        <div className="sc-card p-6">
          <div className="sc-medium">Sign in required</div>
          <div className="sc-body mt-1">
            Settings are tied to your user profile. Sign in as a user (not
            an automation agent) to edit your stakeholder-briefing PDF
            header.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl mx-auto flex flex-col gap-6">
      <h1 className="text-2xl">Settings</h1>

      <ProfileForm
        user={user ?? null}
        userLoading={userLoading}
        userError={userError}
      />
      <ArchitectPdfHeaderForm
        user={user ?? null}
        userLoading={userLoading}
        userError={userError}
      />
    </div>
  );
}

/**
 * `displayName` + `email` self-edit form. Each input has its own
 * dirty/save state so the architect can update one field without the
 * other tagging along — but both fields live under the same Save
 * button (as in the PDF-header form) to keep the surface familiar.
 */
function ProfileForm({
  user,
  userLoading,
  userError,
}: {
  user: ProfileFields | null;
  userLoading: boolean;
  userError: unknown;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [seeded, setSeeded] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Seed the inputs from the server value once it arrives. Same
  // pattern as the PDF-header form — re-seeding on every refetch
  // would yank the cursor mid-typing.
  useEffect(() => {
    if (!seeded && user) {
      setDisplayName(user.displayName ?? "");
      setEmail(user.email ?? "");
      setSeeded(true);
    }
  }, [seeded, user]);

  const mutation = useUpdateMyProfile({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetUserQueryKey(updated.id), updated);
        void queryClient.invalidateQueries({
          queryKey: getGetUserQueryKey(updated.id),
        });
        // Reflect what the server actually persisted (it trims and
        // normalises empty email to null) so the inputs match the DB.
        setDisplayName(updated.displayName ?? "");
        setEmail(updated.email ?? "");
        setSavedNote("Saved.");
      },
    },
  });

  const trimmedDisplayName = displayName.trim();
  const trimmedEmail = email.trim();
  const persistedDisplayName = user?.displayName ?? "";
  const persistedEmail = user?.email ?? "";
  // Match the server's normalisation so a draft of "  foo  " on top
  // of "foo" doesn't light up the Save button spuriously, and
  // emptying an already-empty email field doesn't either.
  const displayNameDirty = trimmedDisplayName !== persistedDisplayName;
  const emailDirty = trimmedEmail !== persistedEmail;
  const isDirty = displayNameDirty || emailDirty;
  const displayNameInvalid = trimmedDisplayName.length === 0;

  return (
    <form
      className="sc-card p-6 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!isDirty || displayNameInvalid) return;
        setSavedNote(null);
        // Send only the fields that changed — matches the server's
        // partial-update contract and avoids ticking `updatedAt` on
        // columns the architect didn't touch.
        const data: {
          displayName?: string;
          email?: string | null;
        } = {};
        if (displayNameDirty) data.displayName = displayName;
        if (emailDirty) {
          // Empty / whitespace-only email clears the column server-
          // side; send the raw input so the server's trim is the
          // single source of truth.
          data.email = email;
        }
        mutation.mutate({ data });
      }}
    >
      <div>
        <div className="sc-label">Display name &amp; email</div>
        <div className="sc-body mt-1">
          The name and contact email shown on engagement timelines and
          stakeholder PDFs. Leave email blank to clear it.
        </div>
      </div>

      {userLoading ? (
        <div className="sc-body">Loading current values…</div>
      ) : userError ? (
        <div
          className="alert-block critical rounded-md"
          data-testid="settings-profile-load-error"
        >
          <div className="sc-medium">Couldn&apos;t load your profile</div>
          <div className="sc-body mt-1">Please refresh and try again.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="sc-meta">Display name</span>
            <input
              type="text"
              className="sc-input"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSavedNote(null);
              }}
              placeholder="e.g. Alex Architect"
              data-testid="settings-display-name-input"
              maxLength={200}
              aria-label="Display name"
            />
            {displayNameDirty && displayNameInvalid ? (
              <span
                className="sc-body text-[var(--danger)]"
                data-testid="settings-display-name-error"
              >
                Display name can&apos;t be blank.
              </span>
            ) : null}
          </label>
          <label className="flex flex-col gap-1">
            <span className="sc-meta">Email</span>
            <input
              type="email"
              className="sc-input"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setSavedNote(null);
              }}
              placeholder="you@example.com"
              data-testid="settings-email-input"
              maxLength={200}
              aria-label="Email"
            />
          </label>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="sc-btn-primary"
          disabled={
            mutation.isPending ||
            !isDirty ||
            displayNameInvalid ||
            !!userError
          }
          data-testid="settings-profile-save"
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
        {savedNote ? (
          <span
            className="sc-body sc-meta"
            data-testid="settings-profile-status"
          >
            {savedNote}
          </span>
        ) : null}
        {mutation.isError ? (
          <span
            className="sc-body text-[var(--danger)]"
            data-testid="settings-profile-error"
          >
            Couldn&apos;t save. Try again.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Stakeholder briefing PDF header self-edit form. Pulled out of the
 * page body unchanged from its DA-PI-6 implementation so the new
 * profile form above can sit alongside without forcing an inline
 * refactor of either.
 *
 * Task #365 — Carries a live mini-preview underneath the input that
 * mirrors the PDF header's typography and falls back to the platform
 * default (in a muted/italic style) when the input is empty or
 * whitespace-only, so the architect can iterate on wording without
 * round-tripping through a real export.
 */
function ArchitectPdfHeaderForm({
  user,
  userLoading,
  userError,
}: {
  user: ProfileFields | null;
  userLoading: boolean;
  userError: unknown;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && user) {
      setDraft(user.architectPdfHeader ?? "");
      setSeeded(true);
    }
  }, [seeded, user]);

  const [savedNote, setSavedNote] = useState<string | null>(null);
  const mutation = useUpdateMyArchitectPdfHeader({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetUserQueryKey(updated.id), updated);
        void queryClient.invalidateQueries({
          queryKey: getGetUserQueryKey(updated.id),
        });
        setDraft(updated.architectPdfHeader ?? "");
        setSavedNote(
          updated.architectPdfHeader === null
            ? "Cleared — exports will use the default header."
            : "Saved.",
        );
      },
    },
  });

  const trimmedDraft = draft.trim();
  const currentValue = user?.architectPdfHeader ?? "";
  // "Dirty" if the trimmed draft differs from what's persisted —
  // matches what the server will actually store (it trims + nulls
  // empty strings), so a draft of "  Foo  " on top of "Foo" doesn't
  // light up the Save button spuriously.
  const isDirty = trimmedDraft !== currentValue;
  const willClear = trimmedDraft.length === 0;

  // Live-preview text mirrors what the PDF route would actually print
  // for this draft today: a non-empty trimmed value renders verbatim,
  // an empty / whitespace-only input falls back to the platform
  // default (matching the server's `header ?? DEFAULT_…` resolution
  // in `briefingHtml.ts`). The fallback flag drives the muted /
  // italic styling so the architect can see at a glance which
  // contract is in effect.
  const isPreviewFallback = trimmedDraft.length === 0;
  const previewText = isPreviewFallback
    ? DEFAULT_BRIEFING_PDF_HEADER
    : trimmedDraft;

  return (
    <form
      className="sc-card p-6 flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setSavedNote(null);
        mutation.mutate({
          data: {
            // Send raw input — the server trims and treats empty /
            // whitespace-only as "clear the override", so a single
            // Save covers both set and reset.
            architectPdfHeader: draft,
          },
        });
      }}
    >
      <div>
        <div className="sc-label">Stakeholder briefing PDF header</div>
        <div className="sc-body mt-1">
          Shown at the top of every page of the briefing PDF you export.
          Leave blank to use the platform default
          (&ldquo;SmartCity Design Tools&nbsp;&mdash; Pre-Design
          Briefing&rdquo;).
        </div>
      </div>

      {userLoading ? (
        <div className="sc-body">Loading current value…</div>
      ) : userError ? (
        <div
          className="alert-block critical rounded-md"
          data-testid="settings-load-error"
        >
          <div className="sc-medium">Couldn&apos;t load your profile</div>
          <div className="sc-body mt-1">
            Please refresh and try again.
          </div>
        </div>
      ) : (
        <>
          <input
            type="text"
            className="sc-input"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setSavedNote(null);
            }}
            placeholder="SmartCity Design Tools — Pre-Design Briefing"
            data-testid="settings-architect-pdf-header-input"
            maxLength={200}
            aria-label="Stakeholder briefing PDF header"
          />

          {/*
            Live mini-preview of the PDF header. Inline styles
            intentionally — the PDF renderer prints its header from
            CSS literal tokens (font-family / font-size / color in
            `briefingHtml.ts`'s `@page @top-left` margin box) rather
            than from any shared design-token, so mirroring those
            same literals here is the most direct way to keep the
            two surfaces visually in sync. Wrapped in a card-like
            frame with a dotted bottom rule so it reads as "the top
            edge of a printed page" rather than just another text
            line on the form.
          */}
          <div className="mt-1">
            <div className="sc-meta mb-1">Live preview</div>
            <div
              aria-label="PDF header live preview"
              style={{
                background: "#ffffff",
                border: "1px solid #ddd",
                borderRadius: 3,
                padding: "10px 14px 8px",
              }}
            >
              <div
                data-testid="settings-architect-pdf-header-preview"
                data-preview-fallback={
                  isPreviewFallback ? "true" : "false"
                }
                style={{
                  fontFamily:
                    '-apple-system, system-ui, "Helvetica Neue", Arial, sans-serif',
                  fontSize: "9pt",
                  fontWeight: 400,
                  color: isPreviewFallback ? "#888" : "#555",
                  fontStyle: isPreviewFallback ? "italic" : "normal",
                  borderBottom: "1px dotted #ccc",
                  paddingBottom: 6,
                  lineHeight: 1.3,
                  // Long headers truncate the same way they do in
                  // the printed margin box (single line, clipped at
                  // the right edge), so the architect sees how
                  // their wording will actually fit before exporting.
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {previewText}
              </div>
            </div>
          </div>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="sc-btn-primary"
          disabled={mutation.isPending || !isDirty || !!userError}
          data-testid="settings-architect-pdf-header-save"
        >
          {mutation.isPending
            ? "Saving…"
            : willClear && isDirty
              ? "Clear override"
              : "Save"}
        </button>
        {savedNote ? (
          <span
            className="sc-body sc-meta"
            data-testid="settings-architect-pdf-header-status"
          >
            {savedNote}
          </span>
        ) : null}
        {mutation.isError ? (
          <span
            className="sc-body text-[var(--danger)]"
            data-testid="settings-architect-pdf-header-error"
          >
            Couldn&apos;t save. Try again.
          </span>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Subset of the User shape both forms read. Keeping the prop type
 * narrow (rather than importing the generated `User`) means the form
 * components don't have to deal with `createdAt`/`updatedAt` they
 * never use, and the parent can pass `null` cleanly while the data
 * loads.
 */
interface ProfileFields {
  id: string;
  displayName: string;
  email: string | null;
  avatarUrl?: string | null;
  architectPdfHeader: string | null;
}

export default Settings;
