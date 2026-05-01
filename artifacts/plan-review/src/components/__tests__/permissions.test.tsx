/**
 * Regression tests for the route-level `RequirePermission` gates on the
 * ADMIN sidebar pages — "Users & Roles" (Task #110), "Reviewer Pool"
 * and "Settings" (Task #121).
 *
 * Each gate is what stops a non-admin from landing on the page
 * directly and seeing chrome before every action 403s server-side.
 * Three pieces have to stay wired up for each to keep working:
 *
 *   1. The matching `<Route>` in `App.tsx` wraps the page component in
 *      `<RequirePermission permission="…">` (the admin pages all use a
 *      `<resource>:manage` claim).
 *   2. `usePermissionStatus("<resource>:manage")` (in `lib/session.ts`)
 *      returns `"denied"` when the session does not list the claim,
 *      and `"granted"` when it does.
 *   3. The denied branch renders the `AccessDenied` view (with the
 *      "Back to inbox" link), not the gated page.
 *
 * If any of those changes silently — a route loses its wrapper, a
 * permission key is renamed, the session hook starts returning a
 * different shape, etc. — these tests fail. The Users & Roles case
 * mirrors the dev `x-permissions: users:manage` header used by the
 * API-side test (`artifacts/api-server/src/__tests__/users.test.ts`)
 * by mocking `useGetSession` to return the same claim shape the
 * server would. Reviewer Pool / Settings still resolve to the
 * `ComingSoon` stub today (no real admin pages yet), so the granted
 * assertion just checks the stub renders and the access-denied
 * fallback does not — the gate plumbing is what we're pinning down.
 *
 * Implementation pattern follows
 * `artifacts/design-tools/src/components/__tests__/SubmissionDetailModal.test.tsx`
 * — `vi.hoisted` shared state plus a module mock that returns
 * deterministic shapes from each generated React-Query hook, so we
 * don't need a real network or QueryClient.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const hoisted = vi.hoisted(() => {
  return {
    session: null as null | {
      data?: { permissions?: ReadonlyArray<string> };
      isLoading?: boolean;
    },
    listUsers: null as null | {
      data?: unknown;
      isLoading?: boolean;
      error?: unknown;
    },
  };
});

vi.mock("@workspace/api-client-react", () => ({
  useGetSession: () => hoisted.session ?? { isLoading: true },
  getGetSessionQueryKey: () => ["getSession"],
  useListUsers: () => hoisted.listUsers ?? { isLoading: true },
  getListUsersQueryKey: () => ["listUsers"],
  // Mutations are wired up at module-load time inside the Users page,
  // even though the modals (which actually fire them) only render
  // after a click. Provide no-op stubs so the page mounts cleanly.
  useCreateUser: () => ({ mutate: () => {}, isPending: false }),
  useUpdateUser: () => ({ mutate: () => {}, isPending: false }),
  useDeleteUser: () => ({ mutate: () => {}, isPending: false }),
}));

vi.mock("@workspace/object-storage-web", () => ({
  // The avatar field calls `useUpload` only inside the create/edit modals,
  // which never open in this test. The stub keeps the import resolvable.
  useUpload: () => ({
    uploadFile: () => {},
    isUploading: false,
    error: null,
    progress: 0,
  }),
}));

const App = (await import("../../App")).default;

beforeEach(() => {
  hoisted.session = null;
  hoisted.listUsers = null;
  // Boot the app at the gated admin route. `import.meta.env.BASE_URL`
  // resolves to "/" under vitest, so wouter's base reduces to "" and
  // the route matches `/users` directly.
  window.history.pushState({}, "", "/users");
});

describe("/users access gating", () => {
  it(
    "renders the access-denied screen (with a Back to inbox link) " +
      "when the session has no users:manage claim",
    () => {
      // Same shape the server returns to a non-admin caller — the dev
      // `x-permissions` header is simply not set, so `permissions` is
      // empty.
      hoisted.session = { data: { permissions: [] }, isLoading: false };

      render(<App />);

      const denied = screen.getByTestId("access-denied");
      expect(denied).toBeInTheDocument();
      expect(denied.textContent).toContain("Access denied");

      const back = screen.getByTestId("access-denied-home");
      expect(back).toBeInTheDocument();
      expect(back.textContent).toContain("Back to inbox");
      expect(back).toHaveAttribute("href", "/");

      // The admin form must NOT have rendered — that's the whole point
      // of the gate. The "+ Add profile" button is the most visible
      // marker that the Users page mounted.
      expect(screen.queryByTestId("users-add-button")).toBeNull();
    },
  );

  it(
    "renders the Users admin form when the session carries the " +
      "users:manage claim (mirrors the dev x-permissions header on the API)",
    () => {
      hoisted.session = {
        data: { permissions: ["users:manage"] },
        isLoading: false,
      };
      // Empty list is fine — the page header (with the Add button) and
      // the empty-state copy both render before any users come back.
      hoisted.listUsers = { data: [], isLoading: false };

      render(<App />);

      // Admin form chrome is present…
      expect(screen.getByTestId("users-add-button")).toBeInTheDocument();
      expect(screen.getByText("User profiles")).toBeInTheDocument();

      // …and the access-denied fallback is NOT.
      expect(screen.queryByTestId("access-denied")).toBeNull();
    },
  );
});

/**
 * Reviewer Pool and Settings are still ComingSoon stubs, but the
 * route-level gate has to be in place *before* a real admin page
 * lands there — otherwise the first deploy that swaps in the real
 * page exposes admin chrome to non-admins for as long as it takes
 * to ship the gate. These tests cover the plumbing today (URL
 * resolves to access-denied without the claim, ComingSoon stub
 * with it) so the wrapper cannot be silently dropped during the
 * upcoming "real admin page" PR.
 *
 * The granted-side check looks for the stub copy ("Coming soon —
 * this view is in design.") rather than asserting the whole page —
 * once the real admin page replaces the stub the assertion will
 * need to be updated to the new chrome, which is exactly the
 * moment the gate's grant path should be re-verified anyway.
 */
describe.each([
  {
    label: "Reviewer Pool",
    path: "/reviewers",
    permission: "reviewers:manage",
  },
  {
    label: "Settings",
    path: "/settings",
    permission: "settings:manage",
  },
])("$path access gating", ({ path, permission }) => {
  it(
    `renders the access-denied screen when the session has no ${permission} claim`,
    () => {
      window.history.pushState({}, "", path);
      hoisted.session = { data: { permissions: [] }, isLoading: false };

      render(<App />);

      const denied = screen.getByTestId("access-denied");
      expect(denied).toBeInTheDocument();
      expect(denied.textContent).toContain("Access denied");

      // The ComingSoon stub copy must not be visible — the gate has
      // to win over the page underneath, even when that page is just
      // a placeholder.
      expect(screen.queryByText(/Coming soon/i)).toBeNull();
    },
  );

  it(
    `renders the (currently stubbed) page when the session carries the ${permission} claim`,
    () => {
      window.history.pushState({}, "", path);
      hoisted.session = {
        data: { permissions: [permission] },
        isLoading: false,
      };

      render(<App />);

      // Stub copy is present and the access-denied fallback is not —
      // confirms the gate's granted branch falls through to the
      // routed component.
      expect(screen.getByText(/Coming soon/i)).toBeInTheDocument();
      expect(screen.queryByTestId("access-denied")).toBeNull();
    },
  );
});
