import dotenv from "dotenv";

import { createSmartsiteMcpApp } from "./app.js";
import { isAuthConfigured, loadAuthConfig } from "./auth.js";
import { SERVER_NAME } from "./constants.js";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "8080", 10);

async function main(): Promise<void> {
  const authConfig = loadAuthConfig();
  const app = createSmartsiteMcpApp({ authConfig });

  app.listen(PORT, () => {
    console.log(
      JSON.stringify({
        event: "smartsite_mcp_listen",
        port: PORT,
        name: SERVER_NAME,
        authConfigured: isAuthConfigured(authConfig),
      }),
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
