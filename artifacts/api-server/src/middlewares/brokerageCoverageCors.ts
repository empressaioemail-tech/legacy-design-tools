import cors from "cors";

/** Public read-only CORS for coverage manifest embeds (hauska.dev/mcp/coverage). */
export const brokerageCoveragePublicCors = cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }
    const allowed =
      origin === "https://hauska.dev" ||
      origin === "https://www.hauska.dev" ||
      origin === "https://brief.hauska.dev" ||
      origin.endsWith(".hauska.dev");
    callback(null, allowed);
  },
  methods: ["GET", "OPTIONS"],
});
