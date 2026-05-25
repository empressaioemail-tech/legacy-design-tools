#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/__tests__/__fixtures__/schema.sql.template",
);

let text = fs.readFileSync(fixture, "utf8");
text = text.replace(/\n-- Canva Connect \(0020\)[\s\S]*$/, "\n");

const engagementsCreate = `CREATE TABLE @@SCHEMA@@.engagements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    name_lower text NOT NULL,
    jurisdiction text,
    address text,
    applicant_firm text,
    architect_of_record_name text,
    architect_of_record_email text,
    architect_of_record_role text,
    status text DEFAULT 'active'::text NOT NULL,
    latitude numeric(9,6),
    longitude numeric(9,6),
    geocoded_at timestamp with time zone,
    geocode_source text,
    jurisdiction_city text,
    jurisdiction_state text,
    jurisdiction_fips text,
    substrate_jurisdiction_key text,
    cortex_jurisdiction_key text,
    coverage_status text DEFAULT 'unknown'::text NOT NULL,
    coverage_requested_at timestamp with time zone,
    project_type text,
    zoning_code text,
    lot_area_sqft numeric,
    site_context_raw jsonb,
    revit_central_guid text,
    revit_document_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`;

text = text.replace(
  /CREATE TABLE @@SCHEMA@@\.engagements \([\s\S]*?\);/,
  engagementsCreate,
);

const workspaceCreate = `CREATE TABLE @@SCHEMA@@.workspace_settings (
    id text DEFAULT 'default'::text NOT NULL,
    firm_display_name text DEFAULT 'Cortex Workspace'::text NOT NULL,
    logo_url text,
    primary_color text,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    practice_states jsonb DEFAULT '[]'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);`;

text = text.replace(
  /CREATE TABLE @@SCHEMA@@\.workspace_settings \([\s\S]*?\);/,
  workspaceCreate,
);

const canvaTables = `
-- Name: canva_connections; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.canva_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    owner_user_id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: canva_design_pushes; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.canva_design_pushes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    engagement_id uuid NOT NULL,
    push_job_id uuid,
    template_id text NOT NULL,
    template_name text NOT NULL,
    status text DEFAULT 'uploading'::text NOT NULL,
    thumbnail_url text,
    design_url text,
    source_asset_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: canva_oauth_states; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.canva_oauth_states (
    state text NOT NULL,
    code_verifier text NOT NULL,
    owner_user_id text NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: canva_push_jobs; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.canva_push_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    engagement_id uuid NOT NULL,
    step text DEFAULT 'preparing'::text NOT NULL,
    progress_label text NOT NULL,
    request jsonb NOT NULL,
    design_url text,
    design_thumbnail_url text,
    error_code text,
    error_message text,
    canva_autofill_job_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

`;

const collateralTables = `
-- Name: collateral_export_jobs; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.collateral_export_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    engagement_id uuid NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    step text DEFAULT 'preparing'::text NOT NULL,
    progress_label text NOT NULL,
    request jsonb NOT NULL,
    download_url text,
    thumbnail_url text,
    error_code text,
    error_message text,
    placid_pdf_id text,
    credits_estimated integer,
    credits_actual integer,
    provider text DEFAULT 'placid'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: collateral_exports; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.collateral_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    engagement_id uuid NOT NULL,
    export_job_id uuid,
    template_pack_id text NOT NULL,
    template_name text NOT NULL,
    status text DEFAULT 'rendering'::text NOT NULL,
    download_url text,
    thumbnail_url text,
    source_asset_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    credits_charged integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: collateral_metering_events; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.collateral_metering_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id text DEFAULT 'default'::text NOT NULL,
    engagement_id uuid NOT NULL,
    export_job_id uuid NOT NULL,
    units integer NOT NULL,
    provider text DEFAULT 'placid'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


-- Name: coverage_requests; Type: TABLE; Schema: public; Owner: -

CREATE TABLE @@SCHEMA@@.coverage_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    engagement_id uuid NOT NULL,
    jurisdiction_state text,
    jurisdiction_city text,
    jurisdiction_fips text,
    note text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

`;

text = text.replace(
  /(-- Name: canned_findings; Type: TABLE[\s\S]*?\);\n\n\n)(-- Name: code_atom_fetch_queue)/,
  `$1${canvaTables}$2`,
);
text = text.replace(
  /(-- Name: code_atoms; Type: TABLE[\s\S]*?\);\n\n\n)(-- Name: decision_pdf_artifacts)/,
  `$1${collateralTables}$2`,
);

const canvaConstraints = `
-- Name: canva_connections canva_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.canva_connections
    ADD CONSTRAINT canva_connections_pkey PRIMARY KEY (id);


-- Name: canva_design_pushes canva_design_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.canva_design_pushes
    ADD CONSTRAINT canva_design_pushes_pkey PRIMARY KEY (id);


-- Name: canva_oauth_states canva_oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.canva_oauth_states
    ADD CONSTRAINT canva_oauth_states_pkey PRIMARY KEY (state);


-- Name: canva_push_jobs canva_push_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.canva_push_jobs
    ADD CONSTRAINT canva_push_jobs_pkey PRIMARY KEY (id);


`;

const collateralConstraints = `
-- Name: collateral_export_jobs collateral_export_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.collateral_export_jobs
    ADD CONSTRAINT collateral_export_jobs_pkey PRIMARY KEY (id);


-- Name: collateral_exports collateral_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.collateral_exports
    ADD CONSTRAINT collateral_exports_pkey PRIMARY KEY (id);


-- Name: collateral_metering_events collateral_metering_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.collateral_metering_events
    ADD CONSTRAINT collateral_metering_events_pkey PRIMARY KEY (id);


-- Name: coverage_requests coverage_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.coverage_requests
    ADD CONSTRAINT coverage_requests_pkey PRIMARY KEY (id);


`;

text = text.replace(
  /(ADD CONSTRAINT canned_findings_pkey PRIMARY KEY \(id\);\n\n\n)(-- Name: code_atom_fetch_queue)/,
  `$1${canvaConstraints}$2`,
);
text = text.replace(
  /(ADD CONSTRAINT code_atoms_pkey PRIMARY KEY \(id\);\n\n\n)(-- Name: decision_pdf_artifacts)/,
  `$1${collateralConstraints}$2`,
);

const coverageFk = `
-- Name: coverage_requests coverage_requests_engagement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -

ALTER TABLE ONLY @@SCHEMA@@.coverage_requests
    ADD CONSTRAINT coverage_requests_engagement_id_fkey FOREIGN KEY (engagement_id) REFERENCES @@SCHEMA@@.engagements(id) ON DELETE CASCADE;


`;

text = text.replace(
  /(ADD CONSTRAINT code_atoms_source_id_code_atom_sources_id_fk[\s\S]*?;\n\n\n)(-- Name: decision_pdf_artifacts)/,
  `$1${coverageFk}$2`,
);

fs.writeFileSync(fixture, text.endsWith("\n") ? text : text + "\n");
console.log("Patched", fixture);
