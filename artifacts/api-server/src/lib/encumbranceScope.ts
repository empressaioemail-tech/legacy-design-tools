import { buildPropertyWorkspaceDid } from "./brokerageBriefAtoms";

const WORKSPACE_DID_PREFIX = "did:hauska:property-workspace:";

export function listingKeyFromWorkspaceDid(workspaceDid: string): string | null {
  const trimmed = workspaceDid.trim();
  if (!trimmed.startsWith(WORKSPACE_DID_PREFIX)) return null;
  const listingKey = trimmed.slice(WORKSPACE_DID_PREFIX.length);
  return listingKey.length > 0 ? listingKey : null;
}

export function workspaceDidFromListingKey(listingKey: string): string {
  return buildPropertyWorkspaceDid(listingKey);
}
