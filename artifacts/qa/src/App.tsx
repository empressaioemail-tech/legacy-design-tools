import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import SuitesPage from "@/pages/SuitesPage";
import HistoryPage from "@/pages/HistoryPage";
import ChecklistsPage from "@/pages/ChecklistsPage";
import AutopilotPage from "@/pages/AutopilotPage";
import TriagePage from "@/pages/TriagePage";
import { AutopilotBanner } from "@/components/AutopilotBanner";
import { useTriageCounts } from "@/components/triage";
import { Beaker } from "lucide-react";
import { cn } from "@/lib/utils";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1 },
  },
});

const NAV: Array<{ path: string; label: string; key?: "triage" }> = [
  { path: "/", label: "Suites" },
  { path: "/autopilot", label: "Autopilot" },
  { path: "/triage", label: "Triage", key: "triage" },
  { path: "/history", label: "Run history" },
  { path: "/checklists", label: "Manual checklists" },
];

function Shell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const triageQuery = useTriageCounts();
  const triageOpen = triageQuery.data?.counts.open ?? 0;
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-slate-900 p-2 text-white">
              <Beaker className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">SmartCity QA</h1>
              <p className="text-xs text-muted-foreground">
                Internal release-readiness dashboard
              </p>
            </div>
          </div>
          <nav className="flex gap-1" data-testid="nav-tabs">
            {NAV.map((item) => {
              const active =
                item.path === "/"
                  ? location === "/" || location === ""
                  : location.startsWith(item.path);
              return (
                <Link
                  key={item.path}
                  href={item.path}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-slate-900 text-white"
                      : "text-slate-700 hover:bg-slate-100",
                  )}
                  data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                >
                  {item.label}
                  {item.key === "triage" && triageOpen > 0 ? (
                    <span
                      className={cn(
                        "ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold",
                        active
                          ? "bg-white/20 text-white"
                          : "bg-rose-100 text-rose-800",
                      )}
                      data-testid="nav-triage-badge"
                    >
                      {triageOpen}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        <AutopilotBanner />
        {children}
      </main>
    </div>
  );
}

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={SuitesPage} />
        <Route path="/autopilot" component={AutopilotPage} />
        <Route path="/triage" component={TriagePage} />
        <Route path="/history" component={HistoryPage} />
        <Route path="/checklists" component={ChecklistsPage} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
