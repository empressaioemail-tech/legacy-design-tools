---
status: draft
not_filed: true
plan_row: P-88
wdll_item: 19
vendor: OpenAI ChatGPT (custom MCP)
hostname: mcp.smartsite.cloud
last_updated: 2026-08-27
source: artifacts/smartsite-mcp/src/constants.ts, src/health.ts (llms.txt)
---

# ChatGPT custom MCP directory listing — DRAFT

**Do not file until WDLL item 20 passes** (stranger-account probe on whichever vendor completes first; ChatGPT filing is a **second** filing per item 21).

**Account requirement:** ChatGPT custom MCP with full tool access is gated to **Business or Enterprise** plans (per 2026-08-26 exploration). Free and Plus users see **Unavailable** in the Smart Site **Use in your AI** sheet until OpenAI widens access. This packet assumes a Business/Enterprise submitter.

## Listing identity

| Field | Value |
|---|---|
| **MCP server name** | Smart Site |
| **Publisher** | Empressa (Legacy Group ATX LLC) |
| **Product** | Smart Site — property intelligence for Texas parcels |
| **MCP endpoint** | `https://mcp.smartsite.cloud/mcp` |
| **Transport** | Streamable HTTP (MCP protocol `2025-03-26`) |
| **Discovery** | `https://mcp.smartsite.cloud/llms.txt` |

## Short description

Connect Smart Site to ChatGPT to search Texas parcels, open tier-gated smart-site analysis, list your saved properties, run property intelligence reports, and ask questions about a parcel. Sign in with your Smart Site account (Google or Microsoft). No API keys.

## Long description

Smart Site is Empressa's property intelligence workbench for Texas land development. This MCP server exposes **eight curated tools** that mirror jobs a signed-in user can run at [smartsite.cloud](https://smartsite.cloud).

This is the **Smart Site product connector** at `mcp.smartsite.cloud`. It is **not** Hauska MCP (`mcp.hauska.dev`), which serves the developer atom catalog behind `X-Hauska-Key`.

**OAuth only.** Users authorize with OAuth 2.1 + PKCE through WorkOS AuthKit. Refresh tokens are issued (`offline_access`) so ChatGPT keeps tools visible across sessions. There is no key-paste path.

**Tier-aware.** Free, Solo, Studio, and Team Stripe entitlements set the ceiling on each tool result — the same rules as the web workbench. The connector does not grant Studio data to a Free account.

## Connection settings (ChatGPT custom MCP form)

| Field | Value |
|---|---|
| **Server URL** | `https://mcp.smartsite.cloud/mcp` |
| **Authentication** | OAuth 2.1 (follow ChatGPT MCP OAuth flow) |
| **Authorization server metadata** | Discovered via `GET https://mcp.smartsite.cloud/.well-known/oauth-authorization-server` |
| **Protected resource metadata** | `GET https://mcp.smartsite.cloud/.well-known/oauth-protected-resource` |
| **API key / bearer token field** | **Leave empty** — product keys and Hauska keys are not accepted |

### OAuth flow summary

1. ChatGPT (or the user via **Use in your AI** when Connect is live) initiates MCP OAuth against `https://mcp.smartsite.cloud/mcp`.
2. Client discovers AuthKit via Smart Site's `/.well-known/oauth-authorization-server` proxy.
3. User signs in with **Google or Microsoft** (same providers as Smart Site workbench).
4. AuthKit issues access + refresh tokens; JWT audience is `https://mcp.smartsite.cloud/mcp`.
5. Smart Site MCP maps the AuthKit subject to the Smart Site user through `peUserIdentities`; tier comes from `peUserEntitlements`.
6. Each `POST /mcp` call carries `Authorization: Bearer <access_token>`. Missing or invalid token → **401**, no anonymous catalog.

Dynamic client registration and CIMD are supported on AuthKit per MCP vendor requirements.

## Tools (eight)

Titles are property-written (WDLL P-87 item 12). MCP names in backticks.

| # | Title | MCP name | Status |
|---|---|---|---|
| 1 | Find a parcel | `find_parcel` | Live |
| 2 | Get its smart site | `get_smart_site` | Live |
| 3 | List my properties | `list_my_properties` | Live |
| 4 | Run a report | `run_report` | Live |
| 5 | Request records | `request_records` | Not ready (P-85) |
| 6 | Check a request | `check_request` | Not ready (P-85) |
| 7 | Export an instrument | `export_instrument` | Not ready (P-87 export routes) |
| 8 | Ask the map | `ask_the_map` | Live |

### Tool descriptions (for directory copy-paste)

**Find a parcel** — Search for a parcel by address, APN, or parcel node id and return the best match with county and identifiers.

**Get its smart site** — Return the signed-in user's smart site analysis for a parcel: verdicts, citations, and stored artifacts at the caller's tier.

**List my properties** — List parcels the signed-in user has saved in Smart Site (id, parcel node id, label, updatedAt only — no chat or notes).

**Run a report** — Read the R1 property intelligence report for a parcel from the baked facet snapshot. Returns synchronously; no async job is started.

**Request records** — Start a public-records request for a parcel. Not available until Records Request is live on production.

**Check a request** — Poll an async report or records job for queued, running, complete, failed, or needs-human. Not available until Records Request is live.

**Export an instrument** — Export a site plan, terrain model, dossier, or brief artifact the caller's tier allows. Not available until cortex export routes exist for Smart Site MCP.

**Ask the map** — Ask a natural-language question about the current parcel and visible map context.

## Tier note (no API keys)

Smart Site MCP never asks for an API key, product key, or `X-Hauska-Key`. The user's **Smart Site subscription** is the credential.

| Tier | What the MCP respects |
|---|---|
| **Free** | Browse-grade inspect, saved properties, limited chat |
| **Solo** ($49/mo) | Full parcel analysis, unlimited chat |
| **Studio** ($129/mo) | Solo plus deliverables (exports, owner data) when export tools ship |
| **Team** ($299/mo, 10 seats) | Studio for a firm |

Per-answer Hauska metering is not enabled on this connector.

## ChatGPT-specific notes

- **Developer mode / custom MCP** must be enabled on the ChatGPT workspace (Business or Enterprise).
- **Refresh tokens** are required: AuthKit advertises `offline_access` so tool visibility does not drop when short-lived access tokens expire.
- The **interactive map stays on smartsite.cloud**; ChatGPT receives structured tool results, reports, and citations — not an embedded map widget.
- Smart Site workbench **Use in your AI** currently shows ChatGPT as **Unavailable** for non-Business accounts; flip the sheet row to **Connect** only when this account class can complete OAuth end-to-end.

## Example user utterances

- "Use Smart Site to find 801 Pine St Bastrop TX"
- "Open the smart site for parcel 48021:34137"
- "What properties do I have saved in Smart Site?"
- "Run a property report on 48021:34137"
- "Using Smart Site, what's the zoning on this parcel?"

Acceptance gold parcel: `48021:34137`.

## Support

| Field | Value |
|---|---|
| **Product** | https://smartsite.cloud |
| **MCP discovery** | https://mcp.smartsite.cloud/llms.txt |
| **Support contact** | (operator: fill before filing) |

## Pre-filing checklist

- [ ] Item 20 probe completed on Claude (or primary vendor) first
- [ ] Separate ChatGPT Business/Enterprise probe: Connect → OAuth → gold parcel at probe account tier
- [ ] 401 probe on revoked session
- [ ] Submitted URL is `mcp.smartsite.cloud`, not Cloud Run default hostname
- [ ] Submission contains zero API-key or Hauska MCP references
