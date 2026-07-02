import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CortexProvider } from "@hauska/cortex-tiles";
import { createCortexClient } from "@hauska/cortex-client";
import CortexShell from "./tile-shell/AppCortexShell";
import TileDevPage from "./tile-dev/TileDevPage";
import CommentLetterPage from "./pages/CommentLetterPage";
import NotFound from "./pages/not-found";

const queryClient = new QueryClient();

// Cortex client for the package-resident tiles. The plan-review BFF authorizes
// browser requests via the same-origin `pr_session` cookie
// (requireServiceTokenOrSession): a present-but-non-service Authorization
// header is rejected 401, so getToken returns "" here and the client omits the
// Authorization header and sends credentials with each request. baseUrl "/api"
// + the client's "/plan-review/..." paths reproduce the app's original BASE.
const cortexClient = createCortexClient({
  baseUrl: "/api",
  getToken: () => "",
});

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={() => <CortexShell initialPresetId="plan-review" />} />
      <Route path="/tile-dev/:tileId">
        {(params) => <TileDevPage tileId={params.tileId} />}
      </Route>
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
      <CortexProvider client={cortexClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
      </CortexProvider>
    </QueryClientProvider>
  );
}
