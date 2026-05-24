import { LogOut, User } from "lucide-react";

/**
 * Top-right auth affordance for the design-tools SPA.
 *
 * Gateway-assumed: the current-user label and sign-out are stubs until
 * a real `/api/me` lands. The button navigates to the gateway's logout
 * path when one is configured via `VITE_LOGOUT_URL`; otherwise it just
 * returns to the projects home so it doesn't strand the user on a 404
 * in environments without an auth gateway (e.g. local dev / Replit
 * preview).
 */
const LOGOUT_URL =
  (import.meta.env?.VITE_LOGOUT_URL as string | undefined) ?? "/";

export function AuthChip() {
  const handleSignOut = () => {
    window.location.href = LOGOUT_URL;
  };

  return (
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
        title="Signed in (gateway-assumed identity)"
      >
        <User size={12} />
        Operator
      </span>
      <button
        type="button"
        onClick={handleSignOut}
        aria-label="Sign out"
        title="Sign out"
        data-testid="auth-chip-signout"
        style={{
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
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--depth-hover-bg)";
          e.currentTarget.style.color = "var(--text-primary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--text-secondary)";
        }}
      >
        <LogOut size={14} />
      </button>
    </div>
  );
}
