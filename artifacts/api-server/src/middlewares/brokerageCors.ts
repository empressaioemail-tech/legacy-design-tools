import cors from "cors";

/**
 * CORS for Hauska Property Brief Chrome extension only.
 * Allows `chrome-extension://*` origins; other origins are rejected when
 * an Origin header is present (curl / server-to-server omit Origin).
 */
export const brokerageCors = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (origin.startsWith("chrome-extension://")) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Hauska-Key",
    "X-Hauska-Install-Id",
  ],
  exposedHeaders: ["X-Hauska-Billable"],
});
