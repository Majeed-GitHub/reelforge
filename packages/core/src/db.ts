import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './config.ts';

let db: DatabaseSync | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  sign_in_mode TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Credentials and captured sessions are stored encrypted (see crypto.ts).
CREATE TABLE IF NOT EXISTS environment_secrets (
  environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE,
  credentials TEXT,
  storage_state TEXT,
  captured_at TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  attested_at TEXT,
  verification_token TEXT NOT NULL,
  verified_at TEXT,
  UNIQUE (workspace_id, host)
);

CREATE TABLE IF NOT EXISTS demos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  instruction TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  video_path TEXT,
  poster_path TEXT,
  srt_path TEXT,
  duration_ms INTEGER,
  outcome_json TEXT,
  failure_json TEXT,
  question_json TEXT,
  answer_json TEXT,
  options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  credits_used REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_demos_ws ON demos(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demos_status ON demos(status);

CREATE TABLE IF NOT EXISTS demo_steps (
  demo_id TEXT NOT NULL REFERENCES demos(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  narration TEXT NOT NULL DEFAULT '',
  started_at_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_ms INTEGER NOT NULL DEFAULT 0,
  selector TEXT,
  role TEXT,
  name TEXT,
  box_json TEXT,
  url TEXT,
  screenshot_path TEXT,
  PRIMARY KEY (demo_id, idx)
);

CREATE TABLE IF NOT EXISTS flows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'fresh',
  stale_reason TEXT,
  first_seen_at TEXT NOT NULL,
  last_verified_at TEXT,
  UNIQUE (environment_id, signature)
);

CREATE TABLE IF NOT EXISTS flow_steps (
  flow_id TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  selector TEXT,
  role TEXT,
  name TEXT,
  url TEXT,
  label TEXT,
  PRIMARY KEY (flow_id, idx)
);

CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  url_path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL DEFAULT '',
  screenshot_path TEXT,
  last_seen_at TEXT NOT NULL,
  UNIQUE (environment_id, url_path)
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'help_center',
  status TEXT NOT NULL DEFAULT 'draft',
  published_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_ws ON articles(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS guides (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  flow_id TEXT REFERENCES flows(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  embed_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  delta_seconds REAL NOT NULL,
  reason TEXT NOT NULL,
  demo_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  code TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS questions_answers (
  demo_id TEXT PRIMARY KEY REFERENCES demos(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL,
  answered_at TEXT NOT NULL
);
`;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDirs();
  fs.mkdirSync(path.dirname(PATHS.db), { recursive: true });
  db = new DatabaseSync(PATHS.db);
  db.exec(SCHEMA);
  return db;
}

/** Test helper: fresh in-memory database with the same schema. */
export function openMemoryDb(): DatabaseSync {
  const mem = new DatabaseSync(':memory:');
  mem.exec(SCHEMA);
  return mem;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
