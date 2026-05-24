import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DashboardPage } from "./pages/DashboardPage";
import { EngagementDetail } from "./pages/EngagementDetail";
import { PackageShareViewerPage } from "./pages/PackageShareViewerPage";
import { EngagementCompare } from "./pages/EngagementCompare";
import StyleProbe from "./pages/StyleProbe";
import { Health } from "./pages/Health";
import { CodeLibrary } from "./pages/CodeLibrary";
import { DevAtoms } from "./pages/DevAtoms";
import { DevAtomsProbe } from "./pages/DevAtomsProbe";
import { Settings } from "./pages/Settings";
import { InboxPage } from "./pages/InboxPage";
import { Workspace } from "./pages/Workspace";
import { SharedWithMe } from "./pages/SharedWithMe";
import NotFound from "./pages/not-found";
import { AppShell } from "./components/AppShell";
import { SettingsAreaLayout } from "./components/settings/SettingsAreaLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/">
        <DashboardPage />
      </Route>
      <Route path="/share/:token">
        <PackageShareViewerPage />
      </Route>
      <Route path="/engagements/:id/compare">
        <EngagementCompare />
      </Route>
      <Route path="/engagements/:id">
        <EngagementDetail />
      </Route>
      <Route path="/code-library">
        <AppShell title="Code Library">
          <CodeLibrary />
        </AppShell>
      </Route>
      <Route path="/style-probe">
        <AppShell title="Style Probe">
          <SettingsAreaLayout>
            <StyleProbe />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route path="/health">
        <AppShell title="API Health">
          <SettingsAreaLayout>
            <Health />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route path="/settings">
        <AppShell title="Settings">
          <Settings />
        </AppShell>
      </Route>
      <Route path="/inbox">
        <InboxPage />
      </Route>
      <Route path="/notifications">
        <InboxPage />
      </Route>
      <Route path="/workspace">
        <AppShell title="Workspace">
          <SettingsAreaLayout>
            <Workspace />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route path="/workspace/shared">
        <AppShell title="Shared with me">
          <SettingsAreaLayout>
            <SharedWithMe />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route path="/dev/atoms">
        <AppShell title="Atom Inspector">
          <SettingsAreaLayout>
            <DevAtoms />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route path="/dev/atoms/probe">
        <AppShell title="Retrieval Probe">
          <SettingsAreaLayout>
            <DevAtomsProbe />
          </SettingsAreaLayout>
        </AppShell>
      </Route>
      <Route>
        <NotFound />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
