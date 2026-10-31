// SQLite store: our local copy of the helpdesk. Everything the report needs is
// read from here (level 2 needs sub-10s reports from ~12k requests, which we
// could never do by querying the helpdesk live without hammering it into 429s).
//
// `requests`/`events` hold "as it is now" snapshots applied from the change
// feed; upserts are idempotent, so duplicated change items (which the API doc
// promises) and cursor-expiry restarts are harmless.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY,
      ref TEXT,
      title TEXT,
      location TEXT,
      site_id INTEGER,
      status TEXT,
      priority TEXT,
      created_at INTEGER,          -- unix seconds (UTC instants)
      updated_at INTEGER,
      due_on TEXT,                 -- informational; the real deadline is on events (rule 6)
      assignee_id INTEGER,
      deleted_at INTEGER,
      merged_into_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);

    CREATE TABLE IF NOT EXISTS events (
      request_id INTEGER NOT NULL,
      id INTEGER NOT NULL,
      status TEXT,
      at INTEGER,                  -- unix seconds
      actor_id INTEGER,
      actor_name TEXT,
      due_at TEXT,                 -- raw site-local "DD/MM/YYYY HH:mm"; parsed in rules.js
      reverts_id INTEGER,
      PRIMARY KEY (request_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_request ON events (request_id, at);

    CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY, name TEXT);

    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY,
      name TEXT,
      timezone TEXT,
      business_hours TEXT          -- JSON blob of the per-day open windows
    );

    CREATE TABLE IF NOT EXISTS holidays (
      site_id INTEGER NOT NULL,
      date TEXT NOT NULL,          -- site-local YYYY-MM-DD, normalized on insert
      name TEXT,
      PRIMARY KEY (site_id, date)
    );

    CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT);

    -- Materialized report rows (rule outcomes per request), rebuilt for the
    -- affected requests whenever a change arrives. /ready only flips after
    -- these exist for every synced request.
    CREATE TABLE IF NOT EXISTS report_rows (
      request_id INTEGER PRIMARY KEY,           -- = requests.id
      site_id INTEGER,
      local_date TEXT,                          -- site-local date of created_at (rule 1)
      responder_id INTEGER,
      response_business_minutes INTEGER,        -- floored minutes (rule 4)
      within_target INTEGER,                    -- 1/0/NULL (rule 5)
      completed_late INTEGER                    -- 1/0/NULL (rule 6)
    );
    CREATE INDEX IF NOT EXISTS idx_report_rows_date ON report_rows (local_date);
    CREATE INDEX IF NOT EXISTS idx_report_rows_site ON report_rows (site_id);
  `);
  return db;
}

export function getState(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setState(db, key, value) {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, String(value));
}
