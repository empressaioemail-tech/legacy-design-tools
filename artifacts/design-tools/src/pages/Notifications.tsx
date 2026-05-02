import { useEffect } from "react";
import { Link } from "wouter";
import {
  useListMyNotifications,
  getListMyNotificationsQueryKey,
  useMarkMyNotificationsRead,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Architect inbox page.
 *
 * Renders the newest-first list returned by `GET /me/notifications`
 * and fires the mark-read mutation once on mount so the side-nav
 * badge clears as soon as the architect opens the surface. The
 * mutation invalidates the list query so the per-row `read` flags
 * flip to `true` without a manual refetch.
 *
 * Each row is a deep link to `/engagements/{engagementId}` — the
 * canonical surface where reviewer status changes and reviewer-
 * requests show up in context.
 */
export function Notifications() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useListMyNotifications(undefined, {
    query: {
      queryKey: getListMyNotificationsQueryKey(),
      refetchInterval: 5000,
    },
  });

  const markRead = useMarkMyNotificationsRead({
    mutation: {
      onSuccess: () => {
        // Invalidate so per-row `read` flags rehydrate on next fetch.
        queryClient.invalidateQueries({
          queryKey: getListMyNotificationsQueryKey(),
        });
      },
    },
  });

  // Fire mark-read once on first render — opening the inbox IS the
  // "view" gesture.
  useEffect(() => {
    markRead.mutate();
    // We deliberately depend on nothing — this should fire exactly
    // once per visit. The mutation handle itself is recreated on
    // every render but we don't want that to retrigger the call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--chrome-text-sec)" }}>Loading inbox…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--chrome-text-sec)" }}>
          Could not load notifications.
        </p>
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div style={{ padding: 24 }} data-testid="notifications-empty">
        <p style={{ color: "var(--chrome-text-sec)" }}>
          No notifications yet — reviewer activity will appear here.
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <ul
        style={{ listStyle: "none", margin: 0, padding: 0 }}
        data-testid="notifications-list"
      >
        {data.items.map((item) => {
          const href = item.engagementId
            ? `/engagements/${item.engagementId}`
            : "/";
          return (
            <li
              key={item.id}
              data-testid="notification-row"
              data-read={item.read ? "true" : "false"}
              style={{
                borderBottom: "1px solid var(--chrome-border)",
                padding: "12px 0",
              }}
            >
              <Link
                href={href}
                style={{
                  display: "block",
                  textDecoration: "none",
                  color: "var(--chrome-text)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    fontWeight: item.read ? 400 : 600,
                  }}
                >
                  {!item.read && (
                    <span
                      data-testid="unread-dot"
                      aria-label="Unread"
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "#6398AA",
                        display: "inline-block",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <span>{item.title}</span>
                </div>
                {item.engagementName && (
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--chrome-text-sec)",
                      marginTop: 2,
                    }}
                  >
                    {item.engagementName}
                  </div>
                )}
                {item.body && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--chrome-text-sec)",
                      marginTop: 4,
                    }}
                  >
                    {item.body}
                  </div>
                )}
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--chrome-text-sec)",
                    marginTop: 4,
                  }}
                >
                  {new Date(item.occurredAt).toLocaleString()}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
