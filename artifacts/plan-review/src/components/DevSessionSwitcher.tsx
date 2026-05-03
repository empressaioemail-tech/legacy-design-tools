import { useEffect, useState } from "react";
import {
  clearDevSessionCookie,
  getDevSessionAudience,
  setDevSessionAudience,
  type DevAudience,
} from "../lib/devSession";

/**
 * Dev-only floating session switcher (Task #504).
 *
 * Plan Review's reviewer surfaces gate on `audience === "internal"`,
 * but there's no real auth flow yet — by default the browser lands
 * as the anonymous applicant (`audience: "user"`) and every
 * `/api/reviewer/*` call returns 403. This pill lives in the
 * bottom-right corner during dev/preview and lets the operator
 * pick the audience their browser session presents.
 *
 * Hidden in production via `import.meta.env.PROD`. The
 * `sessionMiddleware` also fail-closes the cookie in production, so
 * even if this component shipped to prod the cookie write would be
 * ignored at the door.
 */
export function DevSessionSwitcher() {
  if (import.meta.env.PROD) return null;
  return <DevSessionSwitcherInner />;
}

function DevSessionSwitcherInner() {
  const [audience, setAudience] = useState<DevAudience | null>(() =>
    getDevSessionAudience(),
  );
  const [open, setOpen] = useState(false);

  // Re-read on mount in case another tab updated the cookie.
  useEffect(() => {
    setAudience(getDevSessionAudience());
  }, []);

  const apply = (next: DevAudience | null) => {
    if (next === null) {
      clearDevSessionCookie();
    } else {
      setDevSessionAudience(next);
    }
    setAudience(next);
    setOpen(false);
    // Reload so every cached `useGetSession` / `useListReviewerQueue`
    // consumer re-fetches against the new audience without us having
    // to thread invalidation through every page.
    window.location.reload();
  };

  const labelFor = (a: DevAudience | null): string => {
    if (a === "internal") return "Reviewer";
    if (a === "user") return "Architect";
    return "Anonymous";
  };

  return (
    <div
      data-testid="dev-session-switcher"
      style={{
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: 1000,
        fontFamily: "var(--font-ui, system-ui, sans-serif)",
      }}
    >
      {open ? (
        <div
          data-testid="dev-session-switcher-menu"
          style={{
            background: "var(--bg-card, #11161c)",
            border: "1px solid var(--border-default, #2a2f37)",
            borderRadius: 6,
            padding: 8,
            minWidth: 180,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <div
            style={{
              fontSize: 10,
              letterSpacing: 0.6,
              textTransform: "uppercase",
              color: "var(--text-muted, #6b7280)",
              padding: "4px 6px",
            }}
          >
            Dev session
          </div>
          <DevOption
            testId="dev-session-switcher-option-internal"
            label="Reviewer (internal)"
            active={audience === "internal"}
            onClick={() => apply("internal")}
          />
          <DevOption
            testId="dev-session-switcher-option-user"
            label="Architect (user)"
            active={audience === "user"}
            onClick={() => apply("user")}
          />
          <DevOption
            testId="dev-session-switcher-option-clear"
            label="Clear (anonymous)"
            active={audience === null}
            onClick={() => apply(null)}
          />
        </div>
      ) : (
        <button
          type="button"
          data-testid="dev-session-switcher-toggle"
          data-audience={audience ?? "anonymous"}
          onClick={() => setOpen(true)}
          style={{
            background: audience === "internal" ? "#1f5c4a" : "#3a3320",
            color: "#e6e8eb",
            border: "1px solid var(--border-default, #2a2f37)",
            borderRadius: 999,
            padding: "6px 12px",
            fontSize: 11,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: audience === "internal" ? "#4ade80" : "#fbbf24",
            }}
          />
          dev: {labelFor(audience)}
        </button>
      )}
    </div>
  );
}

function DevOption({
  testId,
  label,
  active,
  onClick,
}: {
  testId: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      style={{
        textAlign: "left",
        background: active ? "var(--bg-input, #1a1f27)" : "transparent",
        color: "var(--text-primary, #e6e8eb)",
        border: "none",
        borderRadius: 4,
        padding: "6px 8px",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {active ? "● " : "○ "}
      {label}
    </button>
  );
}
