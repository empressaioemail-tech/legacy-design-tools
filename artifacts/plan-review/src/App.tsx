import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ReviewConsole from "./pages/ReviewConsole";
import SubmittalDetail from "./pages/SubmittalDetail";
import FindingsLibrary from "./pages/FindingsLibrary";
import CodeLibrary from "./pages/CodeLibrary";
import StyleProbe from "./pages/StyleProbe";
import ComingSoon from "./pages/ComingSoon";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={ReviewConsole} />
      <Route path="/submittals/:id" component={SubmittalDetail} />
      <Route path="/findings" component={FindingsLibrary} />
      <Route path="/code" component={CodeLibrary} />
      <Route path="/style-probe" component={StyleProbe} />
      
      {/* Other routes from nav groups */}
      <Route path="/in-review" component={ComingSoon} />
      <Route path="/approved" component={ComingSoon} />
      <Route path="/rejected" component={ComingSoon} />
      <Route path="/compliance" component={ComingSoon} />
      <Route path="/firms" component={ComingSoon} />
      <Route path="/projects" component={ComingSoon} />
      <Route path="/integrations" component={ComingSoon} />
      <Route path="/users" component={ComingSoon} />
      <Route path="/reviewers" component={ComingSoon} />
      <Route path="/settings" component={ComingSoon} />

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
