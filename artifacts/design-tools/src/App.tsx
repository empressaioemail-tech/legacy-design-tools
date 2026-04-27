import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workbench } from "./pages/Workbench";
import StyleProbe from "./pages/StyleProbe";
import { Health } from "./pages/Health";
import { Stub } from "./pages/Stub";
import { DashboardLayout } from "@workspace/portal-ui";

const queryClient = new QueryClient();

const navGroups = [
  {
    label: "WORKSPACE",
    items: [
      { label: "Workbench", href: "/" },
      { label: "Style Probe", href: "/style-probe" },
    ],
  },
  {
    label: "PROJECTS",
    items: [
      { label: "Seguin Residence", href: "/p/seguin" },
      { label: "Musgrave Residence", href: "/p/musgrave" },
    ],
  },
  {
    label: "DEV",
    items: [
      { label: "API Health", href: "/health" },
    ],
  },
];

function AppLayout({ children, title }: { children: React.ReactNode, title?: string }) {
  return (
    <DashboardLayout
      title={title}
      brandLabel="SMARTCITY OS"
      brandProductName="Design Tools"
      navGroups={navGroups}
    >
      {children}
    </DashboardLayout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Workbench />
      </Route>
      <Route path="/style-probe">
        <AppLayout title="Style Probe">
          <StyleProbe />
        </AppLayout>
      </Route>
      <Route path="/health">
        <AppLayout title="API Health">
          <Health />
        </AppLayout>
      </Route>
      <Route path="/p/:slug">
        <AppLayout title="Project View">
          <Stub />
        </AppLayout>
      </Route>
      <Route>
        <AppLayout>
          <Stub />
        </AppLayout>
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
