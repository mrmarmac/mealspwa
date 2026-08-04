-- Meals sync backend schema.
--
-- `spaces` binds a per-space capability token (trust-on-first-use). Only the
-- sha256 of the token is stored — the server never sees or keeps the token.
--
-- `entities` is the changelog: one row per (space_id, id), holding the latest
-- version by HLC. `body` is the full Syncable JSON blob, stored opaquely; the
-- server only ever reads `updated_at` (an HLC string, lexically comparable).

CREATE TABLE IF NOT EXISTS spaces (
  space_id   TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
  space_id   TEXT NOT NULL,
  id         TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  body       TEXT NOT NULL,
  PRIMARY KEY (space_id, id)
);

-- The "changed since" cursor scan: WHERE space_id = ? AND updated_at > ?.
CREATE INDEX IF NOT EXISTS entities_since ON entities (space_id, updated_at);
