import type { CSSProperties } from "react";
import {
  useGetRenderCredits,
  getGetRenderCreditsQueryKey,
  ApiError,
} from "@workspace/api-client-react";

/**
 * Compact mnml.ai credit-balance chip for the Renders tab (doc 40c
 * B.6). Reads `GET /api/renders/credits`.
 *
 * The balance only moves when a render kickoff or a Prompt Generator
 * call spends credits, so the badge does not poll — those flows
 * invalidate `getGetRenderCreditsQueryKey()` to refresh it, and
 * react-query's default refetch-on-focus covers the rest.
 *
 * When the renders preview is disabled in the environment (503
 * `renders_preview_disabled`) the badge renders nothing: the gallery
 * already surfaces that notice, so a second one would just be noise.
 */

const PILL: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 10px",
  borderRadius: 999,
  border: "1px solid var(--border-default)",
  whiteSpace: "nowrap",
};

export function RenderCreditsBadge() {
  const query = useGetRenderCredits({
    query: {
      queryKey: getGetRenderCreditsQueryKey(),
      staleTime: 30_000,
      retry: false,
    },
  });

  if (query.isLoading) {
    return (
      <span
        className="sc-meta"
        style={{ ...PILL, opacity: 0.6 }}
        data-testid="render-credits-badge-loading"
      >
        mnml credits …
      </span>
    );
  }

  if (query.error) {
    // Renders preview disabled — the gallery owns that message; stay quiet.
    if (query.error instanceof ApiError && query.error.status === 503) {
      return null;
    }
    return (
      <span
        className="sc-meta"
        style={{ ...PILL, opacity: 0.6 }}
        data-testid="render-credits-badge-error"
      >
        mnml credits unavailable
      </span>
    );
  }

  const credits = query.data?.credits ?? 0;
  return (
    <span
      className="sc-meta"
      style={PILL}
      data-testid="render-credits-badge"
      title="Remaining mnml.ai render credits"
    >
      <span aria-hidden style={{ opacity: 0.7 }}>
        ✦
      </span>
      {credits.toLocaleString()} mnml credits
    </span>
  );
}
