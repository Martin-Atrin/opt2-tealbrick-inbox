-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK.

-- One item = one question or approval request from an agent (or a companion app) to the owner.
-- The item's messages are its thread. `version` grows with every change the owner must see before answering
-- (agent messages), so an answer given on an older version is refused as stale.
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('approval', 'question')),
  title TEXT NOT NULL,
  context TEXT,
  responses TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'expired')),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  version INTEGER NOT NULL,
  acked_at INTEGER,
  snoozed_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX inbox_items_open ON inbox_items (status, expires_at);
CREATE INDEX inbox_items_from ON inbox_items (from_id, status);

CREATE TABLE inbox_messages (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items (id),
  author TEXT NOT NULL CHECK (author IN ('agent', 'owner')),
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX inbox_messages_item ON inbox_messages (item_id, created_at, id);

-- At most one decision per item: who answered, when, with what.
CREATE TABLE inbox_decisions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL UNIQUE REFERENCES inbox_items (id),
  response TEXT NOT NULL,
  message TEXT,
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  item_version INTEGER NOT NULL
);

-- Owner alert DMs through Connect (optional; off by default). `input` is the exact companion-call input, kept so
-- that a held send can be repeated with the same input and idempotency key after the owner approves it in Connect.
CREATE TABLE inbox_deliveries (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inbox_items (id),
  channel TEXT NOT NULL CHECK (channel IN ('buzz', 'channel')),
  op TEXT NOT NULL,
  input TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'held', 'failed')),
  hold_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX inbox_deliveries_due ON inbox_deliveries (status, next_at);
CREATE INDEX inbox_deliveries_item ON inbox_deliveries (item_id);

CREATE TABLE inbox_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
