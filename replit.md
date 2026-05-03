# SmartCity OS

## Overview

SmartCity OS is a pnpm monorepo project designed to manage urban development engagements and plan reviews. It consists of three React+Vite frontend applications (Plan Review, Design Tools, and an internal QA Dashboard) and an Express API, all sharing a common design system. The platform integrates with a Postgres database and features real-time AI chat capabilities using Claude.

Its core purpose is to streamline the process of managing project engagements, ingesting design snapshots from tools like Revit, performing plan reviews, and generating comprehensive site briefings. The system aims to provide a centralized platform for urban planning, incorporating various data sources and AI-driven insights to facilitate efficient decision-making and project oversight.

Key capabilities include:
- Managing top-level project engagements with status tracking.
- Ingesting and processing design snapshots from external tools, automatically creating engagements if necessary.
- Providing a plan-review console to visualize and analyze design data.
- Offering AI-powered chat for querying engagement and snapshot data.
- Generating multi-section site briefings based on integrated data sources and AI analysis.
- Integrating with various federal, state, and local data adapters for site context analysis.
- Handling secure file uploads and object storage.

## User Preferences

- I prefer a clear and concise summary of the project.
- I want the agent to focus on essential information for guiding its coding tasks.
- I need the information to be structured in a specific order: Overview, User Preferences, System Architecture, and External Dependencies.
- I do not want any changelogs, update logs, or date-wise entries.
- I want the agent to prioritize high-level features and architectural decisions over granular implementation details.
- I prefer consolidated and non-redundant information.
- I want the external dependencies to list only those actually integrated into the project.

## System Architecture

The project is structured as a pnpm monorepo containing multiple packages:

**Frontend Applications:**
- **artifacts/design-tools:** Manages engagements, displays detailed engagement information, snapshot timelines, raw JSON viewers, and integrates Claude chat.
- **artifacts/plan-review:** A console for plan reviews, displaying real Revit snapshots and sheet summaries.

**Backend API:**
- **artifacts/api-server:** An Express.js API using Pino for logging and Drizzle ORM with Postgres. It handles:
    - Engagement and snapshot management (list, retrieve, create snapshots).
    - AI chat streaming via SSE, leveraging Anthropic's Claude model.
    - Atom summaries for single entities.
    - Secure presigned URL generation for object uploads to GCS.
    - Serving public and private uploaded objects.
    - Generating site briefings and managing their status.
    - Integrating with various data adapters (federal, state, local) to generate layers for site context analysis, with caching mechanisms for adapter results.

**Shared Libraries:**
- **lib/portal-ui:** A common design system for UI components (e.g., `DashboardLayout`, `Sidebar`, `Header`).
- **lib/api-client-react:** Orval-generated React Query hooks for API interaction.
- **lib/api-spec:** OpenAPI specification as the source of truth for the API.
- **lib/api-zod:** Generated Zod schemas for validation.
- **lib/db:** Drizzle schema for Postgres (`engagements`, `snapshots`) and database migration/seeding scripts.
- **lib/integrations-anthropic-ai:** Integration with Anthropic's AI services.
- **lib/object-storage-web:** Browser-side helpers for object uploads.
- **lib/adapters:** Implements DA-PI-4 and DA-PI-2 for federal, state, and local site context data. It provides a runner for various adapters, jurisdiction resolution, and setback table loading.
- **lib/briefing-engine:** Synthesizes multi-section site briefings using AI (Claude Sonnet 4.5) or a mock generator, handling citation resolution and event emission.

**Technology Stack:**
- **Monorepo:** pnpm workspaces
- **Backend:** Node.js 24, Express 5, Pino, Zod, Drizzle ORM, node-postgres, esbuild (for server bundle), tsx (for seed scripts).
- **Frontend:** React 18, Vite 7, TanStack Query, Zustand, Wouter, Tailwind CSS, Lucide.
- **AI:** Anthropic SDK (proxied via Replit AI Integrations).
- **API Codegen:** Orval.
- **Testing:** Vitest (unit), Playwright (end-to-end).

**UI/UX Decisions:**
- The design system (`lib/portal-ui`) ensures a consistent look and feel across both React applications.
- Dashboards present engagement lists with KPI counts and status pills.
- Engagement details include KPI strips, snapshot timelines, and raw JSON viewers.
- Site Context tab in the UI displays A–G section cards for briefings with dynamic expansion and a "Generate/Regenerate Briefing" button with status polling.

**Key Features:**
- **Auto-creation of Engagements:** Snapshots automatically create new engagements if a matching project name is not found.
- **Real-time Chat:** Claude-powered chat for interactive querying of engagement data.
- **Site Briefing Engine:** Generates comprehensive, multi-section site briefings based on aggregated data and AI analysis.
- **Adapter-based Site Context:** Integrates diverse geographical and regulatory data sources to enrich engagement information.
- **DXF→glb Converter:** Supports conversion of DXF files to glb format, with a mock and an HTTP-based production implementation.

## External Dependencies

- **PostgreSQL:** Primary database for persistent storage (Replit-managed Postgres).
- **Anthropic AI:** Used for AI chat and briefing generation (accessed via Replit AI Integrations).
- **Revit:** External design tool that posts snapshots to the API.
- **Google Cloud Storage (GCS):** Used for object storage (e.g., avatar uploads).
- **Federal Data Sources (via Adapters):** FEMA NFHL, USGS NED, EPA EJScreen, FCC National Broadband Map.
- **State Data Sources (via Adapters):** Utah/UGRC, Idaho/INSIDE Idaho, Texas/TCEQ.
- **Local Data Sources (via Adapters):** Grand County UT, Lemhi County ID, Bastrop TX.
- **DXF Converter Service:** An external service (mocked in dev, HTTP in prod) for converting DXF files to glb format.