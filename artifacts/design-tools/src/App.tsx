import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EngagementList } from "./pages/EngagementList";
import { EngagementDetail } from "./pages/EngagementDetail";
import StyleProbe from "./pages/StyleProbe";
import { Health } from "./pages/Health";
import { AppShell } from "./components/AppShell";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <EngagementList />
      </Route>
      <Route path="/engagements/:id">
        <EngagementDetail />
      </Route>
      <Route path="/style-probe">
        <AppShell title="Style Probe">
          <StyleProbe />
        </AppShell>
      </Route>
      <Route path="/health">
        <AppShell title="API Health">
          <Health />
        </AppShell>
      </Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
