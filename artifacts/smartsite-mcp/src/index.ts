import dotenv from "dotenv";

import { SERVER_NAME } from "./constants.js";
import {
  PARCEL_TILES_ORIGIN_ENV_NAME,
  ParcelTilesOriginError,
  requireParcelTilesOrigin,
} from "./parcel-tiles-origin.js";

dotenv.config();

const PORT = parseInt(process.env.PORT ?? "8080", 10);

/** P-446: refuse to boot without parcel tile origin (D-42), not at page-build time only. */
export function assertParcelTilesOriginConfigured(): void {
  requireParcelTilesOrigin();
}

async function main(): Promise<void> {
  try {
    assertParcelTilesOriginConfigured();
  } catch (err) {
    if (err instanceof ParcelTilesOriginError) {
      console.error(
        JSON.stringify({
          event: "smartsite_mcp_boot_refused",
          refusal: err.refusal,
          message: err.message,
          env: PARCEL_TILES_ORIGIN_ENV_NAME,
        }),
      );
      process.exit(1);
    }
    throw err;
  }
  if (process.argv.includes("--print-app-html")) {
    const { buildAppHtml } = await import("./mcp-app.js");
    process.stdout.write(buildAppHtml());
    process.exit(0);
  }
  const { createSmartsiteMcpApp } = await import("./app.js");
  const { isAuthConfigured, loadAuthConfig } = await import("./auth.js");
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
