import { createRoot } from "react-dom/client";
import { initTheme } from "@workspace/portal-ui/theme";
import { applyDevDefaultAudienceOnce } from "./lib/devSession";
import App from "./App";
import "./index.css";

if (import.meta.env.DEV) {
  applyDevDefaultAudienceOnce();
}

initTheme();
createRoot(document.getElementById("root")!).render(<App />);
