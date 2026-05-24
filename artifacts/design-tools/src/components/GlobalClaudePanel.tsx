import { useParams, useLocation } from "wouter";
import {
  useGetEngagement,
  getGetEngagementQueryKey,
} from "@workspace/api-client-react";
import { ClaudeChat } from "./ClaudeChat";
import {
  resolveTabFromSearchParams,
  type TabId,
} from "./engagement-detail/engagementViews";

function readActiveTabFromLocation(): TabId | undefined {
  if (typeof window === "undefined") return undefined;
  return resolveTabFromSearchParams(new URLSearchParams(window.location.search));
}

/**
 * Persistent architect agent rail — mounted from AppShell on every route.
 */
export function GlobalClaudePanel() {
  const params = useParams<{ id?: string }>();
  const [location] = useLocation();
  const engagementId = params.id ?? "";

  const onEngagementRoute =
    !!engagementId && location.startsWith(`/engagements/${engagementId}`);

  const { data: engagement } = useGetEngagement(engagementId, {
    query: {
      enabled: onEngagementRoute && !!engagementId,
      queryKey: getGetEngagementQueryKey(engagementId),
    },
  });

  const snapshots = engagement?.snapshots ?? [];
  const activeTab = onEngagementRoute ? readActiveTabFromLocation() : undefined;

  const surfaceLabel = (() => {
    if (onEngagementRoute) return activeTab ?? "engagement";
    if (location.startsWith("/inbox") || location.startsWith("/notifications"))
      return "inbox";
    if (location.startsWith("/code-library")) return "code-library";
    if (location === "/") return "projects";
    return "workspace";
  })();

  return (
    <ClaudeChat
      engagementId={onEngagementRoute ? engagementId : ""}
      hasSnapshots={snapshots.length > 0}
      snapshots={snapshots}
      activeTab={surfaceLabel}
    />
  );
}
