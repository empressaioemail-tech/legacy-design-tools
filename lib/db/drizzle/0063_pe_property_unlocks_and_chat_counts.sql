-- R1 paywall (LOCK 2026-07-29) — property-scoped entitlement + signed-in
-- free chat counter.
--
-- pe_property_unlocks: one row per (owner_user_id, tenant_id,
-- parcel_node_id) = "this user unlocked this property, forever" (the $15
-- per-property purchase unit). source records the writer: 'stub' (default),
-- 'dev' (operator dev-unlock), later 'stripe' (one-time payment flow —
-- separate isolated wave; same writer interface).
--
-- pe_chat_message_counts: server-enforced signed-in-free chat counter, one
-- row per (owner_user_id, parcel_node_id); bumped atomically via
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE count < limit RETURNING.

CREATE TABLE IF NOT EXISTS pe_property_unlocks (
  owner_user_id   text NOT NULL,
  tenant_id       text NOT NULL DEFAULT 'default',
  parcel_node_id  text NOT NULL,
  unlocked_at     timestamptz NOT NULL DEFAULT now(),
  source          text NOT NULL DEFAULT 'stub',
  CONSTRAINT pe_property_unlocks_owner_user_id_tenant_id_parcel_node_id_pk
    PRIMARY KEY (owner_user_id, tenant_id, parcel_node_id),
  CONSTRAINT pe_property_unlocks_owner_user_id_users_id_fk
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pe_chat_message_counts (
  owner_user_id   text NOT NULL,
  parcel_node_id  text NOT NULL,
  count           integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_chat_message_counts_owner_user_id_parcel_node_id_pk
    PRIMARY KEY (owner_user_id, parcel_node_id),
  CONSTRAINT pe_chat_message_counts_owner_user_id_users_id_fk
    FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
);
