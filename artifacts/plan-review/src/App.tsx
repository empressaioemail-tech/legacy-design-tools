import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewConsole from "./pages/ReviewConsole";
import EngagementDetail from "./pages/EngagementDetail";
import EngagementsList from "./pages/EngagementsList";
import FindingsLibrary from "./pages/FindingsLibrary";
import CodeLibrary from "./pages/CodeLibrary";
import StyleProbe from "./pages/StyleProbe";
import Sheets from "./pages/Sheets";
import Users from "./pages/Users";
import CannedFindings from "./pages/CannedFindings";
import OutstandingRequests from "./pages/OutstandingRequests";
import ComingSoon from "./pages/ComingSoon";
import { RequirePermission } from "./components/permissions";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={ReviewConsole} />
      <Route path="/engagements" component={EngagementsList} />
      <Route path="/engagements/:id" component={EngagementDetail} />
      <Route path="/findings" component={FindingsLibrary} />
      <Route path="/requests" component={OutstandingRequests} />
      <Route path="/code" component={CodeLibrary} />
      <Route path="/sheets" component={Sheets} />
      <Route path="/style-probe" component={StyleProbe} />
      
      {/* Other routes from nav groups */}
      <Route path="/in-review" component={ComingSoon} />
      <Route path="/approved" component={ComingSoon} />
      <Route path="/rejected" component={ComingSoon} />
      <Route path="/compliance" component={ComingSoon} />
      <Route path="/firms" component={ComingSoon} />
      <Route path="/projects" component={ComingSoon} />
      <Route path="/integrations" component={ComingSoon} />
      <Route path="/users">
        {/* Gate the admin-only Users & Roles page on the same `users:manage`
            claim the sidebar uses to hide the link. Without this guard a
            non-admin pasting the URL directly would see the page chrome and
            then watch every action 403 from the server — `RequirePermission`
            renders a clear access-denied screen instead. */}
        <RequirePermission permission="users:manage">
          <Users />
        </RequirePermission>
      </Route>
      {/* Reviewer Pool and Settings are still ComingSoon stubs, but the
          sidebar already gates them on `reviewers:manage` / `settings:manage`,
          so wrap the routes the same way Users & Roles is wrapped. That way
          when the real admin pages drop in (Task #121), a non-admin pasting
          either URL keeps landing on the access-denied screen instead of
          briefly seeing whatever the new page renders. */}
      <Route path="/reviewers">
        <RequirePermission permission="reviewers:manage">
          <ComingSoon />
        </RequirePermission>
      </Route>
      <Route path="/settings">
        <RequirePermission permission="settings:manage">
          <ComingSoon />
        </RequirePermission>
      </Route>
      {/* PLR-10 — Tenant-scoped canned-finding library curation page.
          Same `settings:manage` claim as Settings; the sidebar entry
          is gated identically so the route and the link stay in sync. */}
      <Route path="/canned-findings">
        <RequirePermission permission="settings:manage">
          <CannedFindings />
        </RequirePermission>
      </Route>

      {/* Fallback to coming soon as requested ("No 404. Just a polite stub.") */}
      <Route component={ComingSoon} />
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
