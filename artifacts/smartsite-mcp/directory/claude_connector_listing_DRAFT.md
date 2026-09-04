---
status: draft
not_filed: true
plan_row: P-88
wdll_item: 19
vendor: Anthropic Claude (custom connector / connector directory)
hostname: mcp.smartsite.cloud
last_updated: 2026-08-27
source: artifacts/smartsite-mcp/src/constants.ts, src/health.ts (llms.txt)
---

# Claude connector directory listing — DRAFT

**Do not file until WDLL item 20 passes** (stranger-account Connect probe + 401 probe recorded).

## Listing identity

| Field | Value |
|---|---|
| **Connector name** | Smart Site |
| **Publisher** | Empressa (Legacy Group ATX LLC) |
| **Product** | Smart Site — property intelligence for Texas parcels |
| **Category** | Real estate / property research |
| **MCP endpoint** | `https://mcp.smartsite.cloud/mcp` |
| **Transport** | Streamable HTTP (MCP protocol `2025-03-26`) |
| **Discovery** | `https://mcp.smartsite.cloud/llms.txt` |
| **Health** | `https://mcp.smartsite.cloud/health` |

## Short description (directory blurb)

Smart Site is Empressa's property intelligence product. Connect your Smart Site account to find Texas parcels, open smart-site analysis with citations and verdicts, list saved properties, run property reports, and ask natural-language questions about a parcel — all at your Stripe tier (Free, Solo, Studio, or Team). OAuth sign-in only; no API keys.

## Long description

Smart Site helps developers, brokers, and land professionals understand what they can build on a parcel: zoning, setbacks, flood hazard, land use, and professional deliverables at higher tiers.

This MCP server exposes **exactly eight** Smart Site jobs to Claude. It is a **product connector**, not the Hauska developer catalog. Results carry the same reasoning, citations, and tier gating as the signed-in workbench at [smartsite.cloud](https://smartsite.cloud).

**Authentication:** OAuth 2.1 with PKCE against the user's Smart Site account (WorkOS AuthKit). Google and Microsoft sign-in match the workbench. Dynamic client registration and CIMD are supported per vendor requirements. Refresh tokens are issued so sessions persist.

**No API keys.** Customers never paste `X-Hauska-Key`, product keys, or Cloud Run URLs. Unauthenticated calls receive HTTP 401 with no public catalog fallback.

**Entitlement:** The caller's Stripe tier is the ceiling. Free sessions see browse-grade inspect; Solo unlocks deep parcel analysis; Studio adds exports and owner data; Team is Studio for a firm. A tool that exceeds the caller's tier refuses with a clear message rather than returning thinned or invented data.

**Not Hauska MCP:** [Hauska MCP](https://mcp.hauska.dev) remains the substrate developer gate (atom search, Codex, ICC). This listing points only at `mcp.smartsite.cloud`.

## Connection URL

```
https://mcp.smartsite.cloud/mcp
```

Claude custom connector flow: paste the HTTPS URL, then **Connect** to start OAuth.

In-app entry (after P-87 item 15 flip): Smart Site workbench → **Use in your AI** → Claude → Connect.

## OAuth summary

| Item | Value |
|---|---|
| **Authorization server** | WorkOS AuthKit (`https://happy-asteroid-26.authkit.app`) |
| **Protocol** | OAuth 2.1 + PKCE (`S256`) |
| **Resource (JWT audience)** | `https://mcp.smartsite.cloud/mcp` |
| **Protected-resource metadata** | `GET https://mcp.smartsite.cloud/.well-known/oauth-protected-resource` |
| **Authorization-server metadata** | `GET https://mcp.smartsite.cloud/.well-known/oauth-authorization-server` (proxies AuthKit) |
| **Registration** | Dynamic client registration; CIMD supported (AuthKit Connect Configuration) |
| **Refresh tokens** | Yes (`offline_access` advertised — required so Claude does not hide tools) |
| **Sign-in providers** | Google, Microsoft (same as Smart Site workbench OIDC BFF) |
| **Identity join** | AuthKit subject → Smart Site user via `peUserIdentities` `(provider, subject)` or verified email; no second account created |
| **Failure modes** | Missing, expired, or revoked bearer → **401** with `WWW-Authenticate` pointing at resource metadata. Bearer-without-OAuth never falls through to a public catalog. |

## Tools (eight — exact set)

Human titles match WDLL P-87 item 12. MCP tool names in backticks.

### Live

1. **Find a parcel** (`find_parcel`) — Search by address, APN, or parcel node id; return best match with county and identifiers.

2. **Get its smart site** (`get_smart_site`) — Return the signed-in user's smart site analysis for a parcel: verdicts, citations, and stored artifacts at the caller's tier.

3. **List my properties** (`list_my_properties`) — List parcels the user has saved (id, parcel node id, label, updatedAt only — no chat or notes).

4. **Run a report** (`run_report`) — Read the R1 property intelligence report for a parcel from the baked facet snapshot. Returns synchronously; no async job is started.

5. **Ask the map** (`ask_the_map`) — Ask a natural-language question about the current parcel and visible map context.

### Not ready (registered; fail closed with honest message)

6. **Request records** (`request_records`) — Start a public-records request for a parcel. **Not available** until Records Request is live on production (P-85).

7. **Check a request** (`check_request`) — Poll an async report or records job for queued, running, complete, failed, or needs-human. **Not available** until Records Request is live (P-85).

8. **Export an instrument** (`export_instrument`) — Export a site plan, terrain model, dossier, or brief artifact the caller's tier allows. **Not available** until cortex export routes exist for Smart Site MCP.

`tools/list` returns all eight names. Blocked tools respond with `not_ready` JSON, not silent success.

## Tier note (no API keys)

| Tier | Monthly | MCP ceiling (summary) |
|---|---|---|
| **Free** | $0 | Map-grade inspect, saved properties, limited chat; no Studio reports or exports |
| **Solo** | $49 | Full parcel analysis, unlimited chat, unlimited properties |
| **Studio** | $129 | Solo plus professional deliverables (exports, owner data) when export tools are live |
| **Team** | $299 (10 seats) | Studio for a firm |

Subscription is the only credential path. Per-call Hauska metering is not live on this connector.

## Example prompts (directory / QA)

- "Find parcel 801 Pine St, Bastrop TX 78602"
- "Get the smart site for parcel node 48021:34137"
- "List my saved properties"
- "Run a report on 48021:34137"
- "Ask the map: what is the flood risk on this parcel?"

Gold fixture for acceptance probes: `48021:34137` (801 Pine St, Bastrop, TX).

## Support and policies

| Field | Value |
|---|---|
| **Product site** | https://smartsite.cloud |
| **Privacy** | https://smartsite.cloud/privacy (confirm before filing) |
| **Terms** | https://smartsite.cloud/terms (confirm before filing) |
| **Support contact** | (operator: fill before filing) |

## Pre-filing checklist (item 20 / 21)

- [ ] Stranger Smart Site account completes Connect → OAuth → gold parcel smart site at that account's tier
- [ ] Revoked / invalid session returns 401
- [ ] Probe artifact names serving revision / image digest
- [ ] Listing URL in directory resolves to `mcp.smartsite.cloud`, not a `*.run.app` hostname
- [ ] No Hauska branding, hostname, or API-key instructions in submitted copy
