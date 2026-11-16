-- Run once in the D1 console (or: wrangler d1 execute <db> --file=schema.sql)
CREATE TABLE IF NOT EXISTS docs (
  path TEXT PRIMARY KEY,
  col TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_col ON docs(col);
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v INTEGER
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', 1);
