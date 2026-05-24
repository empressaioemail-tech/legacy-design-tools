# UI IA — Cockpit consolidation (child branch)

**Branch:** `replit/ui-cockpit-ia-consolidation` (from `replit/ui-mockup-graduation`)

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
- Inbox page uses `DEMO_INBOX_ITEMS` when seed is enabled.

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

Open http://localhost:20296/engagements/{id}?view=review&segment=response-tasks
