import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSession,
  useGetUser,
  useUpdateMyArchitectPdfHeader,
  getGetUserQueryKey,
  getGetSessionQueryKey,
} from "@workspace/api-client-react";

/**
 * Architect-facing Settings — DA-PI-6 / Task #322.
 *
 * Today the only setting is the per-architect override for the
 * stakeholder-briefing PDF header (`users.architect_pdf_header`). The
 * PDF route reads that column on every export and falls back to the
 * platform default when it's null, so the user-visible contract is:
 *
 *   - leave the field empty → exports use
 *     "SmartCity Design Tools — Pre-Design Briefing"
 *   - type a value → exports use that value verbatim, trimmed
 *
 * The form intentionally has a single Save button — submitting an
 * empty / whitespace-only value clears the override server-side, so
 * the architect never has to think about a separate "reset" action.
 */
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

  // Local draft — the input is the source of truth while editing,
  // seeded from the server value once it arrives. We avoid a
  // controlled-from-server pattern because it would yank the cursor
  // mid-typing on every refetch.
  const [draft, setDraft] = useState<string>("");
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && user) {
      setDraft(user.architectPdfHeader ?? "");
      setSeeded(true);
    }
  }, [seeded, user]);

  const queryClient = useQueryClient();
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const mutation = useUpdateMyArchitectPdfHeader({
    mutation: {
      onSuccess: (updated) => {
        // Refresh the cached profile + session so any other surface
        // (today: nothing; tomorrow: a header preview) sees the new
        // value without a manual refresh.
        queryClient.setQueryData(getGetUserQueryKey(updated.id), updated);
        void queryClient.invalidateQueries({
          queryKey: getGetUserQueryKey(updated.id),
        });
        // Reflect the trimmed/cleared value the server actually
        // persisted, so the input matches what's now in the DB.
        setDraft(updated.architectPdfHeader ?? "");
        setSavedNote(
          updated.architectPdfHeader === null
            ? "Cleared — exports will use the default header."
            : "Saved.",
        );
      },
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

  const trimmedDraft = draft.trim();
  const currentValue = user?.architectPdfHeader ?? "";
  // "Dirty" if the trimmed draft differs from what's persisted —
  // matches what the server will actually store (it trims + nulls
  // empty strings), so a draft of "  Foo  " on top of "Foo" doesn't
  // light up the Save button spuriously.
  const isDirty = trimmedDraft !== currentValue;
  const willClear = trimmedDraft.length === 0;

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl mb-6">Settings</h1>

      <form
        className="sc-card p-6 flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setSavedNote(null);
          mutation.mutate({
            data: {
              // Send raw input — the server trims and treats empty /
              // whitespace-only as "clear the override", so a
              // single Save covers both set and reset.
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
    </div>
  );
}

export default Settings;
