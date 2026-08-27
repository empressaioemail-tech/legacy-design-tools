import { describe, expect, it } from "vitest";

import {
  mcpPublicBaseUrl,
  mcpResourceUrl,
  oauthProtectedResourceMetadata,
  wwwAuthenticateHeader,
} from "../src/oauth-metadata.js";

describe("oauth metadata", () => {
  it("names mcp.smartsite.cloud resource and AuthKit issuer", () => {
    expect(mcpResourceUrl()).toBe("https://mcp.smartsite.cloud/mcp");
    expect(mcpPublicBaseUrl()).toBe("https://mcp.smartsite.cloud");
    const meta = oauthProtectedResourceMetadata();
    expect(meta).toEqual({
      resource: "https://mcp.smartsite.cloud/mcp",
      authorization_servers: ["https://happy-asteroid-216.authkit.app"],
      bearer_methods_supported: ["header"],
    });
    expect(wwwAuthenticateHeader()).toContain(
      'resource_metadata="https://mcp.smartsite.cloud/.well-known/oauth-protected-resource"',
    );
  });
});
