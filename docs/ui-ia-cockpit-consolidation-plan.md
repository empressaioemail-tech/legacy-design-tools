# UI IA — Cockpit consolidation (child branch)



**Branch:** `replit/ui-cockpit-ia-consolidation` (from `replit/ui-mockup-graduation`)



## Phases



| Phase | Scope | Status |

|-------|--------|--------|

| 0 | View URL contract (`?view=` + `?segment=`), legacy `?tab=`, IA doc | Done |

| 1 | Unified left rail + global Claude on all routes | Done |

| 2 | Top view header (5 views + segment pills), remove right Views rail | Done |

| 3 | Inbox route `/inbox` + demo seed (tasks, inbox rows) | Done |

| 4 | Snapshots hero token pass, `--overlay-scrim`, engagement body height | Done |

| 5 | ActionQueue-style Inbox (buckets, FYI collapse, aside filters/plan) | Done |

| 6 | Deliver Workbench hub on Presentations (demo, jump to segments) | Done |

| 7 | Testids restored on segments (`engagement-tab-*`), engagement tests updated | Done |

| 8 | Shell one-time defaults (expand Claude + project rail), Sheets `TabHeader` | Done |

| 9 | Remove dead views-rail CSS | Done |
| 10 | Publish view: navigation fix, mission control + launch pipeline segments | Done |



## Layout



- **Unified left rail:** workspace links (Projects, Inbox, Code Library, …) + search + active engagements list.

- **Top view header** on engagement routes: Model | Site | Review | Deliver | Publish + Settings gear; segment row under each view.

- **Global Claude panel:** always mounted from `AppShell` via `GlobalClaudePanel`.



## URL



- Canonical: `?view=model|site|review|deliver|publish` with optional `?segment=<tabId>`.

- Legacy `?tab=` still resolves.

- Default bare engagement URL → Model / Snapshots.



## Local demo data



Set `VITE_DEMO_SEED=1` in the design-tools env when running Vite:



- Empty response-task list → demo tasks on engagement.

- Inbox → full ActionQueue buckets + aside filters / today's plan.

- Deliver → Presentations shows workbench hub with lane jump cards.



## Local dev



```powershell

cd P:\ldt-replit-ui

$env:PORT = "8080"

pnpm --filter @workspace/api-server run dev

$env:PORT = "20296"

$env:BASE_PATH = "/"

$env:VITE_DEMO_SEED = "1"

pnpm --filter @workspace/design-tools run dev

```



Open http://localhost:20296/inbox  

Engagement example: http://localhost:20296/engagements/{id}?view=review&segment=response-tasks



## Deferred (post-merge polish)



- Full Cockpit mockup parity on projects list (card density, KPI strip).

- Live inbox API wiring (replace demo-only rows when notifications endpoint supports triage buckets).

- E2e suite if/when Playwright coverage is added for design-tools.


