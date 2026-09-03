import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: "./src/schema",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  // TXGIO-GEOM-FIX: txgio_parcel.geom is a postgis-backed column now (was an
  // uncodified manual addition before this card). The postgis extension owns
  // its own internal tables (spatial_ref_sys, etc.), which push's introspection
  // otherwise mistakes for an ambiguous rename candidate against our own
  // schema. Filtering the extension's own objects out of the diff is the
  // documented fix for exactly this class of false-positive prompt.
  extensionsFilters: ["postgis"],
});
