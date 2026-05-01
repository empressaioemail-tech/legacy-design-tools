/**
 * Regression test for the route-level `RequirePermission` gate on the
 * admin "Users & Roles" page (Task #110).
 *
 * The new gate is what stops a non-admin from landing on `/users`
 * directly and seeing the admin form chrome before every action 403s
 * server-side. Three pieces have to stay wired up for it to keep
 * working:
 *
 *   1. The `<Route path="/users">` in `App.tsx` wraps `<Users />` in
 *      `<RequirePermission permission="users:manage">`.
 *   2. `usePermissionStatus("users:manage")` (in `lib/session.ts`)
 *      returns `"denied"` when the session does not list the claim,
 *      and `"granted"` when it does.
 *   3. The denied branch renders the `AccessDenied` view (with the
 *      "Back to inbox" link), not the `Users` page.
 *
 * If any of those changes silently — the route loses the wrapper, the
 * permission key is renamed, the session hook starts returning a
 * different shape, etc. — this test fails. It mirrors the dev
 * `x-permissions: users:manage` header used by the API-side test
 * (`artifacts/api-server/src/__tests__/users.test.ts`) by mocking
 * `useGetSession` to return the same claim shape the server would.
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
