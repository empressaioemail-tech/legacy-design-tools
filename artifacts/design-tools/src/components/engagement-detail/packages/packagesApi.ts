/**
 * Package + intake API — thin re-exports over the generated OpenAPI client.
 * `absoluteShareUrl` stays local (browser URL helper, not part of the spec).
 */
export {
  createEngagement,
  createEngagementPackage,
  createPackageShare,
  getPackageShare,
  getPackageShare as fetchPackageShare,
  listEngagementPackages,
  listPackageShareComments as listPackageComments,
  postPackageShareComment as postShareComment,
  updateEngagementPackage,
} from "@workspace/api-client-react";

export type {
  CreateEngagementBody,
  EngagementPackageRecord,
  PackageFormSnapshot,
  PackageSelection,
  PackageShareComment,
  PackageShareView,
  PackageTemplateId,
} from "@workspace/api-client-react";

export function absoluteShareUrl(token: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const path = base.endsWith("/")
    ? `${base}share/${token}`
    : `${base}/share/${token}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path.startsWith("/") ? "" : "/"}${path.replace(/^\//, "")}`;
}
