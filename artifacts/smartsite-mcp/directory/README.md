# Smart Site MCP — vendor directory packets (draft)

**Status:** DRAFT — not filed publicly. P-88 WDLL item 19; filing waits on item 20 (live stranger-account probe).

These packets are **Smart Site product listings** for `mcp.smartsite.cloud`. They are not retitled 2026-05 Hauska MCP (`mcp.hauska.dev`) drafts. Hauska MCP remains the developer catalog gate (`X-Hauska-Key`); this connector is OAuth-only against the Smart Site account.

| File | Vendor form |
|---|---|
| `claude_connector_listing_DRAFT.md` | Claude custom connector / connector directory |
| `chatgpt_connector_listing_DRAFT.md` | ChatGPT custom MCP (Business / Enterprise) |

Source of truth for tool copy: `src/constants.ts` and live `GET https://mcp.smartsite.cloud/llms.txt`.
