import { createRoot } from "react-dom/client";
import { initTheme } from "@workspace/portal-ui";
import App from "./App";
import "./index.css";

initTheme();
createRoot(document.getElementById("root")!).render(<App />);