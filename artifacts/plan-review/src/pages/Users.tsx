import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  useListUsers,
  useCreateUser,
  useUpdateUser,
  useDeleteUser,
  getListUsersQueryKey,
  type User,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { useNavGroups } from "../components/NavGroups";
import { resizeAvatar } from "../lib/resizeAvatar";

/**
 * Admin "Users & Roles" view — manages the `users` profile table that
 * hydrates timeline actor labels. Lists every profile, lets the admin
 * add a new one (e.g. ahead of a real session arriving), edit display
 * name / email / avatar, or delete a stale row.
 *
 * Uses the generated react-query hooks from `@workspace/api-client-react`
 * so the wire shapes stay in lockstep with the OpenAPI spec — the only
 * imperative bit is the post-mutation `invalidateQueries` so the list
 * re-fetches without a manual refresh.
 */
export default function Users() {
  const navGroups = useNavGroups();
  const { data: users, isLoading, error } = useListUsers();
  const [editing, setEditing] = useState<User | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <DashboardLayout
      title="Users & Roles"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)]">
              User profiles
            </h2>
            <div className="sc-body mt-1">
              These are the names and avatars shown on engagement timelines
              and audit trails. New profiles also appear automatically the
              first time a user signs in.
            </div>
          </div>
          <button
            type="button"
            className="sc-pill sc-pill-cyan cursor-pointer"
            onClick={() => {
              setEditing(null);
              setCreating(true);
            }}
            data-testid="users-add-button"
          >
            + Add profile
          </button>
        </div>

        <div className="sc-card">
          <div className="sc-card-header sc-row-sb">
            <span className="sc-label">PROFILES</span>
            <span className="sc-meta">
              {users ? `${users.length} total` : ""}
            </span>
          </div>
          {error ? (
            <div className="p-6 sc-body text-[var(--danger)]">
              Failed to load profiles.
            </div>
          ) : isLoading ? (
            <div className="p-6 sc-body">Loading…</div>
          ) : !users || users.length === 0 ? (
            <div className="p-6 sc-body sc-meta">
              No profiles yet. Add one above, or wait for a real sign-in.
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border-subtle)]">
              {users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  onEdit={() => {
                    setCreating(false);
                    setEditing(u);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {creating ? (
        <CreateProfileModal onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <EditProfileModal user={editing} onClose={() => setEditing(null)} />
      ) : null}
    </DashboardLayout>
  );
}

interface UserRowProps {
  user: User;
  onEdit: () => void;
}

function UserRow({ user, onEdit }: UserRowProps) {
  const queryClient = useQueryClient();
  const deleteUser = useDeleteUser({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListUsersQueryKey(),
        });
      },
    },
  });

  const initials = user.displayName
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.avatarUrl}
          alt={user.displayName}
          className="w-9 h-9 rounded-full object-cover shrink-0"
        />
      ) : (
        <div
          className="sc-avatar-mark shrink-0"
          style={{ background: "#6398AA", color: "#0f1318" }}
          aria-hidden
        >
          {initials || "?"}
        </div>
      )}
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <div className="sc-medium truncate" data-testid="user-display-name">
            {user.displayName}
          </div>
          <span className="sc-meta sc-mono-sm shrink-0">{user.id}</span>
        </div>
        <div className="sc-meta truncate">
          {user.email ?? "no email on file"}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          className="sc-pill sc-pill-muted cursor-pointer"
          onClick={onEdit}
          data-testid={`user-edit-${user.id}`}
        >
          Edit
        </button>
        <button
          type="button"
          className="sc-pill sc-pill-red cursor-pointer disabled:opacity-50"
          disabled={deleteUser.isPending}
          onClick={() => {
            if (
              window.confirm(
                `Delete profile for ${user.displayName}? Past timeline events will keep the raw id.`,
              )
            ) {
              deleteUser.mutate({ id: user.id });
            }
          }}
          data-testid={`user-delete-${user.id}`}
        >
          {deleteUser.isPending ? "Deleting…" : "Delete"}
        </button>
      </div>
    </li>
  );
}

interface CreateProfileModalProps {
  onClose: () => void;
}

function CreateProfileModal({ onClose }: CreateProfileModalProps) {
  const queryClient = useQueryClient();
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);

  const createUser = useCreateUser({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListUsersQueryKey(),
        });
        onClose();
      },
      onError: (err: unknown) => {
        void extractErrorMessage(err).then((msg) => {
          setServerError(msg ?? "Failed to create profile");
        });
      },
    },
  });

  return (
    <ModalShell title="Add user profile" onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setServerError(null);
          createUser.mutate({
            data: {
              id: id.trim(),
              displayName: displayName.trim(),
              email: email.trim() ? email.trim() : null,
              avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
            },
          });
        }}
      >
        <Field label="Profile id" hint="Matches the session id (e.g. u1, u_abc123)">
          <input
            style={INPUT_STYLE}
            value={id}
            onChange={(e) => setId(e.target.value)}
            required
            minLength={1}
            data-testid="user-form-id"
          />
        </Field>
        <Field label="Display name">
          <input
            style={INPUT_STYLE}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            minLength={1}
            data-testid="user-form-display-name"
          />
        </Field>
        <Field label="Email" hint="Optional">
          <input
            style={INPUT_STYLE}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="user-form-email"
          />
        </Field>
        <AvatarField
          value={avatarUrl}
          onChange={setAvatarUrl}
          testIdPrefix="user-form"
        />
        {serverError ? (
          <div className="sc-body text-[var(--danger)]">{serverError}</div>
        ) : null}
        <ModalActions
          onClose={onClose}
          submitLabel={createUser.isPending ? "Saving…" : "Create profile"}
          submitDisabled={createUser.isPending}
        />
      </form>
    </ModalShell>
  );
}

interface EditProfileModalProps {
  user: User;
  onClose: () => void;
}

function EditProfileModal({ user, onClose }: EditProfileModalProps) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [email, setEmail] = useState(user.email ?? "");
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [serverError, setServerError] = useState<string | null>(null);

  const updateUser = useUpdateUser({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListUsersQueryKey(),
        });
        onClose();
      },
      onError: (err: unknown) => {
        void extractErrorMessage(err).then((msg) => {
          setServerError(msg ?? "Failed to update profile");
        });
      },
    },
  });

  return (
    <ModalShell title={`Edit ${user.displayName}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setServerError(null);
          // Build a minimal patch — only send fields the admin actually
          // changed so the server's "empty update" guard is satisfied
          // for no-op submits and `email`/`avatarUrl` clearing works as
          // expected (empty input ⇒ explicit null).
          const patch: {
            displayName?: string;
            email?: string | null;
            avatarUrl?: string | null;
          } = {};
          if (displayName.trim() !== user.displayName) {
            patch.displayName = displayName.trim();
          }
          const emailNext = email.trim() ? email.trim() : null;
          if (emailNext !== (user.email ?? null)) patch.email = emailNext;
          const avatarNext = avatarUrl.trim() ? avatarUrl.trim() : null;
          if (avatarNext !== (user.avatarUrl ?? null)) {
            patch.avatarUrl = avatarNext;
          }
          if (Object.keys(patch).length === 0) {
            onClose();
            return;
          }
          updateUser.mutate({ id: user.id, data: patch });
        }}
      >
        <Field label="Profile id">
          <input
            style={{...INPUT_STYLE, opacity: 0.6}}
            value={user.id}
            readOnly
            disabled
          />
        </Field>
        <Field label="Display name">
          <input
            style={INPUT_STYLE}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            required
            minLength={1}
            data-testid="user-edit-display-name"
          />
        </Field>
        <Field label="Email" hint="Leave blank to clear">
          <input
            style={INPUT_STYLE}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="user-edit-email"
          />
        </Field>
        <AvatarField
          value={avatarUrl}
          onChange={setAvatarUrl}
          testIdPrefix="user-edit"
          clearableHint
        />
        {serverError ? (
          <div className="sc-body text-[var(--danger)]">{serverError}</div>
        ) : null}
        <ModalActions
          onClose={onClose}
          submitLabel={updateUser.isPending ? "Saving…" : "Save changes"}
          submitDisabled={updateUser.isPending}
        />
      </form>
    </ModalShell>
  );
}

interface AvatarFieldProps {
  value: string;
  onChange: (next: string) => void;
  testIdPrefix: string;
  clearableHint?: boolean;
}

/**
 * Avatar input — supports two flows in one control:
 *
 *  1. Upload a local image file (drag-pick via the hidden `<input type=file>`),
 *     which goes through the presigned-URL flow in `useUpload`. The returned
 *     canonical `objectPath` (e.g. `/objects/uploads/<uuid>`) is rewritten to
 *     the server's serving URL (`/api/storage<objectPath>`) and dropped into
 *     the same `value` the URL-paste path uses, so `users.avatar_url` is
 *     written exactly the same way the timeline already consumes it.
 *  2. Paste any URL — fallback for external avatars (Gravatar, etc).
 *
 * The preview thumbnail uses an `onError` reset so a broken URL collapses
 * back to the upload affordance instead of leaving a phantom checkbox.
 */
function AvatarField({
  value,
  onChange,
  testIdPrefix,
  clearableHint,
}: AvatarFieldProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);
  const { uploadFile, isUploading, error, progress } = useUpload({
    onSuccess: (response) => {
      // Persist the serving URL (storage mount + objectPath), which is what
      // <img src> can resolve from the browser. The raw `objectPath` alone
      // would not — it is only the canonical key.
      const servingUrl = `/api/storage${response.objectPath}`;
      setPreviewBroken(false);
      onChange(servingUrl);
    },
  });

  return (
    <Field
      label="Avatar"
      hint={
        clearableHint
          ? "Upload an image, paste a URL, or leave blank to clear."
          : "Upload an image or paste a URL. Optional."
      }
    >
      <div className="flex items-center gap-3">
        {value && !previewBroken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={value}
            alt=""
            onError={() => setPreviewBroken(true)}
            onLoad={() => setPreviewBroken(false)}
            className="w-10 h-10 rounded-full object-cover shrink-0 border border-[var(--border-default)]"
            data-testid={`${testIdPrefix}-avatar-preview`}
          />
        ) : (
          <div
            className="sc-avatar-mark shrink-0"
            style={{
              background: "var(--bg-input)",
              color: "var(--text-secondary)",
              border: "1px dashed var(--border-default)",
              width: 40,
              height: 40,
              fontSize: 14,
            }}
            aria-hidden
          >
            {value && previewBroken ? "!" : "+"}
          </div>
        )}
        <button
          type="button"
          className="sc-pill sc-pill-muted cursor-pointer disabled:opacity-50"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          data-testid={`${testIdPrefix}-avatar-upload`}
        >
          {isUploading ? `Uploading… ${progress}%` : "Upload image"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          data-testid={`${testIdPrefix}-avatar-file`}
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset the input value so re-picking the same file still
            // fires `onChange` (browser dedupes identical selections).
            e.target.value = "";
            if (file) {
              setPreviewBroken(false);
              // Downscale + re-encode in the browser so we don't push a
              // multi-megabyte phone photo through the presigned upload
              // for something rendered at 14–36px in timelines.
              void resizeAvatar(file).then((resized) => uploadFile(resized));
            }
          }}
        />
      </div>
      <input
        style={INPUT_STYLE}
        value={value}
        onChange={(e) => {
          setPreviewBroken(false);
          onChange(e.target.value);
        }}
        placeholder="https://… (or upload above)"
        data-testid={`${testIdPrefix}-avatar`}
      />
      {error ? (
        <span className="sc-body text-[var(--danger)]">
          Upload failed: {error.message}
        </span>
      ) : null}
    </Field>
  );
}

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function ModalShell({ title, onClose, children }: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="sc-card w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="sc-row-sb mb-4">
          <h3 className="text-lg font-bold font-['Oxygen'] text-[var(--text-primary)]">
            {title}
          </h3>
          <button
            type="button"
            className="sc-meta cursor-pointer"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="sc-label">{label}</span>
      {children}
      {hint ? <span className="sc-meta">{hint}</span> : null}
    </label>
  );
}

// Shared inline style for text inputs — matches the search input in
// `lib/portal-ui/Header.tsx` so the modal forms read like the rest of
// the app without inventing a new design token.
const INPUT_STYLE: React.CSSProperties = {
  height: 36,
  padding: "0 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border-default)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontFamily: "Inter, sans-serif",
  fontSize: 13,
  outline: "none",
};

interface ModalActionsProps {
  onClose: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
}

function ModalActions({
  onClose,
  submitLabel,
  submitDisabled,
}: ModalActionsProps) {
  return (
    <div className="flex justify-end gap-2 mt-2">
      <button
        type="button"
        className="sc-pill sc-pill-muted cursor-pointer"
        onClick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        className="sc-pill sc-pill-cyan cursor-pointer disabled:opacity-50"
        disabled={submitDisabled}
        data-testid="user-form-submit"
      >
        {submitLabel}
      </button>
    </div>
  );
}

/** Best-effort error message extraction from the generated client's
 * fetch failures — it throws raw `Response` objects on non-2xx, so we
 * try to read the JSON body for the server's `error` field. */
async function extractErrorMessage(err: unknown): Promise<string | null> {
  if (err instanceof Response) {
    try {
      const body = (await err.clone().json()) as { error?: unknown };
      if (typeof body.error === "string") return body.error;
    } catch {
      /* fall through */
    }
    return `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return null;
}
