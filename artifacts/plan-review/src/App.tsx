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
import InReview from "./pages/InReview";
import Approved from "./pages/Approved";
import Rejected from "./pages/Rejected";
import ComplianceEngine from "./pages/ComplianceEngine";
import ComingSoon from "./pages/ComingSoon";
import { RequirePermission, RequireAudience } from "./components/permissions";
import { DevSessionSwitcher } from "./components/DevSessionSwitcher";
import { applyDevDefaultAudienceOnce } from "./lib/devSession";

// Dev/preview-only: when no `pr_session` cookie is set yet (and the
// operator hasn't already picked an audience this browser session),
// auto-default the dev session to Reviewer so opening `/plan-review/`
// from a fresh browser lands directly in the Inbox instead of in the
// audience-mismatch empty state. The DevSessionSwitcher still lets the
// operator flip to Architect or Anonymous, and any explicit choice
// suppresses this default on subsequent loads. Production is left
// untouched (the session middleware also fail-closes the cookie there).
if (!import.meta.env.PROD) {
  applyDevDefaultAudienceOnce();
}

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

      <Route path="/in-review" component={InReview} />
      <Route path="/approved" component={Approved} />
      <Route path="/rejected" component={Rejected} />
      <Route path="/compliance">
        {/* Reviewer-only — gate the route the same way `/users` is
            gated, so a non-reviewer pasting the URL lands on the
            shared access-denied screen instead of the page chrome
            with every action 403'ing. The matching nav entry is
            hidden via `requiresAudience: "internal"` in NavGroups. */}
        <RequireAudience audience="internal">
          <ComplianceEngine />
        </RequireAudience>
      </Route>
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
        <DevSessionSwitcher />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
