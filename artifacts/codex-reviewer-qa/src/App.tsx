import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewPage from "./pages/ReviewPage";
import CommentLetterPage from "./pages/CommentLetterPage";
import NotFound from "./pages/not-found";

/**
 * Codex Reviewer QA — app shell.
 *
 * Phase 2 CDX-3 (one-click AI review pass) is the first data-bound
 * surface: `ReviewPage` at `/` consumes cortex-api's in-process
 * L-surface via `@workspace/api-client-react` — the same generated
 * client `plan-review` and `design-tools` use, not the MCP server.
 * CDX-4 (accept/edit/reject loop) and CDX-5 (jurisdiction switcher)
 * extend that surface. CDX-9 (comment-letter auto-draft) adds
 * `/letter/:letterId` — the drafted Cortex L3 `deliverable-letter`
 * view, reusing the L3/L6 endpoints.
 */
const queryClient = new QueryClient();

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ReviewPage} />
      <Route path="/letter/:letterId">
        {(params) => <CommentLetterPage letterId={params.letterId} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      {/* `base` strips the artifact's `/codex-reviewer-qa` path prefix
          so routes are declared root-relative — mirrors the
          plan-review shell. */}
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppRouter />
      </WouterRouter>
    </QueryClientProvider>
  );
}
