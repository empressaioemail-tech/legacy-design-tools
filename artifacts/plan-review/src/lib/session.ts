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
