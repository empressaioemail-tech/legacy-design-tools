import { Link } from "wouter";
import { DashboardLayout } from "@workspace/portal-ui";
import { useNavGroups } from "./NavGroups";
import { usePermissionStatus } from "../lib/session";

/**
 * Route-level permission gating components.
 *
 * The sidebar already filters admin-only nav entries based on the
 * permission claims returned from `/api/session` (see `useNavGroups` in
 * `./NavGroups`). The same claims need to gate the matching pages —
 * otherwise a non-admin who pastes `/users` directly still sees the page
 * chrome and gets a 403 from every action. {@link RequirePermission}
 * wraps a route's component so it never renders without the right
 * claim, and {@link AccessDenied} provides the friendly fallback view.
 *
 * Both consume `usePermissionStatus` from `../lib/session`, which shares
 * the same React Query cache as `useNavGroups`, so adding a gate does
 * not double-fetch the session.
 */

interface RequirePermissionProps {
  /** The permission claim required to render `children`. */
  permission: string;
  children: React.ReactNode;
  /** Optional override for the access-denied screen heading. */
  deniedTitle?: string;
  /** Optional override for the access-denied body text. */
  deniedMessage?: string;
}

/**
 * Route-level gate: renders `children` only when the current session
 * carries `permission`. While the session is loading, renders a neutral
 * "Checking access…" placeholder inside the standard dashboard chrome
 * so the page does not flash content. When denied, renders
 * {@link AccessDenied} instead of the gated component, which means the
 * gated component's data hooks (and their 403-bound requests) never
 * fire.
 *
 * Designed to be reused for any future admin-only route — wrap the
 * `<Route>`'s component with `<RequirePermission permission="…">`.
 */
export function RequirePermission({
  permission,
  children,
  deniedTitle,
  deniedMessage,
}: RequirePermissionProps) {
  const status = usePermissionStatus(permission);
  if (status === "loading") return <PermissionLoading />;
  if (status === "denied") {
    return <AccessDenied title={deniedTitle} message={deniedMessage} />;
  }
  return <>{children}</>;
}

interface AccessDeniedProps {
  title?: string;
  message?: string;
}

/**
 * Standalone access-denied screen, rendered inside the regular dashboard
 * layout so the user keeps the sidebar (and a way out). The message is
 * intentionally generic — admin-only routes can pass a more specific
 * `message` if helpful, but the default is enough to make the gate feel
 * intentional rather than broken.
 */
export function AccessDenied({
  title = "Access denied",
  message = "You do not have permission to view this page. If you think this is a mistake, ask an administrator to grant your account access.",
}: AccessDeniedProps) {
  const navGroups = useNavGroups();
  return (
    <DashboardLayout
      title={title}
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div
        className="flex items-center justify-center"
        style={{ minHeight: "50vh" }}
      >
        <div
          className="sc-card p-8 max-w-md w-full text-center"
          role="alert"
          aria-live="polite"
          data-testid="access-denied"
        >
          <div className="sc-label" style={{ color: "var(--danger)" }}>
            RESTRICTED
          </div>
          <h2 className="text-[20px] font-bold font-['Oxygen'] text-[var(--text-primary)] mt-2">
            {title}
          </h2>
          <p className="sc-body mt-2">{message}</p>
          <div className="mt-5">
            <Link
              href="/"
              className="sc-pill sc-pill-muted cursor-pointer inline-block"
              data-testid="access-denied-home"
            >
              Back to inbox
            </Link>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}

/**
 * Neutral placeholder shown while the session request is in flight. Same
 * dashboard chrome as the gated page so the layout does not jump once
 * the permission check resolves.
 */
function PermissionLoading() {
  const navGroups = useNavGroups();
  return (
    <DashboardLayout
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
    >
      <div className="p-6 sc-body sc-meta" data-testid="permission-loading">
        Checking access…
      </div>
    </DashboardLayout>
  );
}
