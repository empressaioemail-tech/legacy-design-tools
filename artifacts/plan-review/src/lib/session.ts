import {
  getGetSessionQueryKey,
  useGetSession,
} from "@workspace/api-client-react";

/**
 * Shared session lookup for both the sidebar nav filter and the
 * route-level permission gates.
 *
 * Both consumers share the same React Query key and `Infinity` cache
 * settings, so only one network request actually goes out per app load
 * — admin pages don't double-fetch the session just because they also
 * render the sidebar.
 *
 * `isLoading` is exposed so callers can distinguish "still fetching"
 * from "fetched, no claims": that matters for `RequirePermission`,
 * which would otherwise flash an access-denied screen at a real admin
 * during the initial render.
 */
export function useSessionPermissions(): {
  permissions: ReadonlyArray<string>;
  isLoading: boolean;
} {
  const { data, isLoading } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });
  return { permissions: data?.permissions ?? [], isLoading };
}

/**
 * Resolve the current session's reviewer id (`requestor.id`) for
 * client-side state that needs to be scoped per-user — e.g. the
 * Task #409 BIM gesture-legend "graduated" flag in localStorage.
 *
 * Returns `null` while the session request is in flight or when
 * no `user`-kind requestor is attached (anonymous / agent
 * sessions). Callers that need a stable storage key should
 * substitute their own anonymous-bucket id in that case.
 *
 * Shares the same `Infinity` cache settings as
 * `useSessionPermissions` so adding this hook on a route that
 * already calls the permissions one doesn't double-fetch.
 */
export function useSessionUserId(): string | null {
  const { data } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });
  const requestor = data?.requestor;
  if (!requestor || requestor.kind !== "user") return null;
  return requestor.id;
}

/**
 * Resolve the current session's audience (`internal` for reviewers,
 * `user` for architects, `ai` for agent calls). Returns `null` while
 * the session is loading or the field is absent. Shares the same
 * `Infinity` cache as `useSessionPermissions` to avoid double-fetch.
 */
export function useSessionAudience(): {
  audience: "internal" | "user" | "ai" | null;
  isLoading: boolean;
} {
  const { data, isLoading } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });
  return { audience: data?.audience ?? null, isLoading };
}

/**
 * Tenant the current session belongs to. Returns `null` while the
 * session request is in flight so callers that key tenant-scoped
 * queries off this value can skip firing until the real id is known
 * — avoids briefly aiming the request at the wrong tenant when a
 * future auth layer mints a non-`"default"` claim. The server
 * always populates `tenantId` (defaulting to `"default"` for
 * anonymous / production sessions), so this returns a non-null
 * string once the session resolves.
 *
 * Shares the `Infinity` cache settings with `useSessionPermissions`
 * so it does not double-fetch on routes that already gate on
 * permissions.
 */
export function useSessionTenantId(): string | null {
  const { data } = useGetSession({
    query: {
      queryKey: getGetSessionQueryKey(),
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: Number.POSITIVE_INFINITY,
    },
  });
  return data?.tenantId ?? null;
}

export type PermissionStatus = "loading" | "granted" | "denied";

/**
 * Resolve a single permission claim against the current session. Returns
 * `"loading"` while the session request is in flight so callers can
 * render a neutral placeholder instead of briefly flashing
 * access-denied to a real admin.
 */
export function usePermissionStatus(permission: string): PermissionStatus {
  const { permissions, isLoading } = useSessionPermissions();
  if (isLoading) return "loading";
  return permissions.includes(permission) ? "granted" : "denied";
}
