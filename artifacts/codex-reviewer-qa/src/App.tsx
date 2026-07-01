import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CortexShell } from "./tile-shell/CortexShell";
import TileDevPage from "./tile-dev/TileDevPage";
import CommentLetterPage from "./pages/CommentLetterPage";
import NotFound from "./pages/not-found";

const queryClient = new QueryClient();

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
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <AppRouter />
      </WouterRouter>
    </QueryClientProvider>
  );
}
