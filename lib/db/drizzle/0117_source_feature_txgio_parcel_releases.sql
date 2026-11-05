-- Parcel history: one source_feature partition per TxGIO Land Parcels release
-- (txgio.parcels.2019, 2021-2026), in the P-499 shape (migration 0111). No new
-- per-state table: each release is a partition of the one source_feature table.
--
-- The DDL below is the verbatim output of lib/source-registry
-- partitionDdlForProvider() for the txgio.parcels.<year> registry entries, as
-- migration 0111 instructs; it is not hand-written.
--
-- Writes go through the stage-check-swap path (source_feature_stage, then
-- swapStagedCounty), one release and county per run, so re-loading one
-- release replaces only that release's rows and never another year's.
-- Additive: new partitions and their indexes. No existing table or row changes.

CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2019" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2019');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2019_geom_gist_idx" ON "source_feature_txgio_parcels_2019" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2019_prop_idx" ON "source_feature_txgio_parcels_2019" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2021" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2021');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2021_geom_gist_idx" ON "source_feature_txgio_parcels_2021" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2021_prop_idx" ON "source_feature_txgio_parcels_2021" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2022" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2022');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2022_geom_gist_idx" ON "source_feature_txgio_parcels_2022" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2022_prop_idx" ON "source_feature_txgio_parcels_2022" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2023" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2023');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2023_geom_gist_idx" ON "source_feature_txgio_parcels_2023" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2023_prop_idx" ON "source_feature_txgio_parcels_2023" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2024" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2024');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2024_geom_gist_idx" ON "source_feature_txgio_parcels_2024" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2024_prop_idx" ON "source_feature_txgio_parcels_2024" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2025" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2025');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2025_geom_gist_idx" ON "source_feature_txgio_parcels_2025" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2025_prop_idx" ON "source_feature_txgio_parcels_2025" ((payload ->> 'prop_id'));
CREATE TABLE IF NOT EXISTS "source_feature_txgio_parcels_2026" PARTITION OF "source_feature" FOR VALUES IN ('txgio.parcels.2026');
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2026_geom_gist_idx" ON "source_feature_txgio_parcels_2026" USING GIST ("geom") WHERE geom IS NOT NULL;
CREATE INDEX IF NOT EXISTS "source_feature_txgio_parcels_2026_prop_idx" ON "source_feature_txgio_parcels_2026" ((payload ->> 'prop_id'));
