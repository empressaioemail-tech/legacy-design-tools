import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewerQaHome from "./pages/ReviewerQaHome";
import NotFound from "./pages/not-found";

/**
 * Codex Reviewer QA — app shell (CDX-Phase1-1 scaffold).
 *
 * The `QueryClientProvider` + wouter router are wired now so the
 * Phase 2 reviewer surfaces — CDX-3 one-click review, CDX-4 finding
 * accept/edit/reject loop, CDX-5 jurisdiction switcher, CDX-9
 * comment-letter draft — drop in as additional `<Route>`s without
 * re-plumbing the shell. Those surfaces will read cortex-api's
 * in-process L-surface via `@workspace/api-client-react`, the same
 * path `plan-review` and `design-tools` use; that client is added in
 * the Phase 2 dispatch when the first data-bound page lands.
 */
const queryClient = new QueryClient();

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={ReviewerQaHome} />
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
