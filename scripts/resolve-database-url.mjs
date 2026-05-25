/**
 * Resolve DATABASE_URL from Secret Manager (local dev only).
 * Requires GOOGLE_APPLICATION_CREDENTIALS or default gcloud ADC.
 * Prints connection string to stdout — do not log in CI.
 */
import { GoogleAuth } from "google-auth-library";
import { readFileSync } from "node:fs";

const projectId =
  process.env.GCP_PROJECT_ID ??
  (() => {
    const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyPath) return null;
    const key = JSON.parse(readFileSync(keyPath, "utf8"));
    return key.project_id ?? null;
  })();

if (!projectId) {
  console.error("Set GOOGLE_APPLICATION_CREDENTIALS or GCP_PROJECT_ID");
  process.exit(1);
}

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient();
const token = await client.getAccessToken();
if (!token.token) {
  console.error("Failed to obtain GCP access token");
  process.exit(1);
}

const secretName = process.env.DEPLOYMENT_DATABASE_SECRET ?? "DEPLOYMENT_DATABASE_URL";
const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`;
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${token.token}` },
});
if (!res.ok) {
  console.error(`Secret Manager ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const body = await res.json();
const value = Buffer.from(body.payload.data, "base64").toString("utf8").trim();
if (!value.startsWith("postgres")) {
  console.error("Secret payload is not a postgres URL");
  process.exit(1);
}
process.stdout.write(value);
