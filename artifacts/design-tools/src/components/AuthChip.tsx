import { useState, type CSSProperties, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, User } from "lucide-react";
import {
  getGetSessionQueryKey,
  getListEngagementsQueryKey,
  useGetSession,
} from "@workspace/api-client-react";

const LOGOUT_URL =
  (import.meta.env?.VITE_LOGOUT_URL as string | undefined) ?? undefined;

type AuthMode = "login" | "signup";

async function postAuth(
  path: "/api/auth/login" | "/api/auth/signup",
  body: { email: string; password: string; displayName?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? "auth_failed" };
  }
  return { ok: true };
}

/**
 * Top-right auth affordance — Phase 1 anonymous demo + minimal Phase 2 login.
 */
export function AuthChip() {
  const queryClient = useQueryClient();
  const { data: session } = useGetSession({
    query: { queryKey: getGetSessionQueryKey() },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSignedIn = session?.requestor?.kind === "user";
  const label = isSignedIn
    ? (session.requestor?.id ?? "Signed in")
    : "Guest";

  const refreshSession = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey() });
    await queryClient.invalidateQueries({
      queryKey: getListEngagementsQueryKey(),
    });
  };

  const handleSignOut = async () => {
    if (LOGOUT_URL) {
      window.location.href = LOGOUT_URL;
      return;
    }
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    await refreshSession();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const path =
        mode === "login" ? "/api/auth/login" : "/api/auth/signup";
      const result = await postAuth(path, {
        email: email.trim(),
        password,
        ...(mode === "signup" && displayName.trim()
          ? { displayName: displayName.trim() }
          : {}),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDialogOpen(false);
      setEmail("");
      setPassword("");
      setDisplayName("");
      await refreshSession();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div
        data-testid="auth-chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 32,
          paddingLeft: 8,
          marginLeft: 4,
          borderLeft: "1px solid var(--border-default)",
        }}
      >
        <span
          data-testid="auth-chip-user"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-secondary)",
            fontFamily: "Inter, sans-serif",
            fontSize: 12,
          }}
          title={isSignedIn ? "Signed in" : "Anonymous demo session"}
        >
          <User size={12} />
          {label}
        </span>
        {isSignedIn ? (
          <button
            type="button"
            onClick={() => void handleSignOut()}
            aria-label="Sign out"
            title="Sign out"
            data-testid="auth-chip-signout"
            style={chipButtonStyle}
          >
            <LogOut size={14} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setDialogOpen(true);
            }}
            aria-label="Sign in"
            title="Sign in"
            data-testid="auth-chip-signin"
            style={chipButtonStyle}
          >
            <LogIn size={14} />
          </button>
        )}
      </div>

      {dialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={mode === "login" ? "Sign in" : "Create account"}
          data-testid="auth-chip-dialog"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
          }}
          onClick={() => setDialogOpen(false)}
        >
          <form
            onSubmit={(e) => void handleSubmit(e)}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 320,
              padding: 20,
              borderRadius: 8,
              background: "var(--surface-raised, #1a1a1a)",
              border: "1px solid var(--border-default)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              fontFamily: "Inter, sans-serif",
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {mode === "login" ? "Sign in" : "Create account"}
            </div>
            {mode === "signup" ? (
              <input
                type="text"
                placeholder="Display name (optional)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="auth-chip-display-name"
                style={inputStyle}
              />
            ) : null}
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="auth-chip-email"
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="Password (min 8 chars)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              data-testid="auth-chip-password"
              style={inputStyle}
            />
            {error ? (
              <div
                data-testid="auth-chip-error"
                style={{ fontSize: 12, color: "var(--status-error, #e55)" }}
              >
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              data-testid="auth-chip-submit"
              style={{
                ...inputStyle,
                cursor: busy ? "wait" : "pointer",
                fontWeight: 600,
              }}
            >
              {busy ? "…" : mode === "login" ? "Sign in" : "Sign up"}
            </button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode(mode === "login" ? "signup" : "login");
              }}
              data-testid="auth-chip-toggle-mode"
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-secondary)",
                fontSize: 12,
                cursor: "pointer",
                textAlign: "left",
                padding: 0,
              }}
            >
              {mode === "login"
                ? "Need an account? Sign up"
                : "Already have an account? Sign in"}
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}

const chipButtonStyle: CSSProperties = {
  width: 32,
  height: 32,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--text-secondary)",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  background: "var(--surface-default, #111)",
  color: "var(--text-primary)",
  fontSize: 13,
  boxSizing: "border-box",
};
