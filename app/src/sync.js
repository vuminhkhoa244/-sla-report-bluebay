// Keeps our SQLite copy in sync with the helpdesk via the change feed
// (/v1/changes), per docs/api.md. Backfill once (walking the feed from the
// start), then tail the cursor forever: instantly while has_more, every ~2s
// when caught up, so changes show in the report well under the 60s SLA.
//
// Application of each item is an "upsert the payload as it is now" — the doc
// says items may arrive more than once, so idempotency is the whole model.
import { getState, setState } from "./db.js";
import { materializeRows, materializeAll } from "./rules.js";

const CHANGES_PAGE = 500; // API max
const TAIL_IDLE_MS = 2000; // caught-up poll interval; report freshness SLA is 60s
const TAIL_ERROR_MS = 5000;

// Normalizes timestamps to unix seconds. Events already give seconds; requests
// give ISO. ISO is documented as UTC Z-suffixed; if the Z is missing we assume
// UTC anyway (note for DECISIONS.md — Date.parse would otherwise fall back to
// local time and corrupt every comparison).
export function toSec(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) return Math.floor(Number(v));
  let s = String(v);
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += "Z";
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

const intOrNull = (v) =>
  v === null || v === undefined || v === "" ? null : Math.floor(Number(v));

export function upsertSite(db, s) {
  db.prepare(
    `INSERT INTO sites (id, name, timezone, business_hours)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, timezone = excluded.timezone, business_hours = excluded.business_hours`,
  ).run(
    Number(s.id),
    s.name ?? null,
    s.timezone ?? null,
    s.business_hours ? JSON.stringify(s.business_hours) : null,
  );
}

export function upsertRequest(db, r) {
  db.prepare(
    `INSERT INTO requests (id, ref, title, location, site_id, status, priority,
       created_at, updated_at, due_on, assignee_id, deleted_at, merged_into_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       ref = excluded.ref, title = excluded.title, location = excluded.location,
       site_id = excluded.site_id, status = excluded.status, priority = excluded.priority,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       due_on = excluded.due_on, assignee_id = excluded.assignee_id,
       deleted_at = excluded.deleted_at, merged_into_id = excluded.merged_into_id`,
  ).run(
    Number(r.id),
    r.ref ?? null,
    r.title ?? null,
    r.location ?? null,
    intOrNull(r.site_id),
    r.status ?? null,
    r.priority ?? null,
    toSec(r.created_at),
    toSec(r.updated_at),
    r.due_on ?? null,
    intOrNull(r.assignee?.id ?? r.assignee_id),
    toSec(r.deleted_at),
    intOrNull(r.merged_into_id),
  );
}

export function upsertEvent(db, requestId, e) {
  db.prepare(
    `INSERT INTO events (request_id, id, status, at, actor_id, actor_name, due_at, reverts_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (request_id, id) DO UPDATE SET
       status = excluded.status, at = excluded.at, actor_id = excluded.actor_id,
       actor_name = excluded.actor_name, due_at = excluded.due_at,
       reverts_id = excluded.reverts_id`,
  ).run(
    Number(requestId),
    Number(e.id),
    e.status ?? null,
    toSec(e.at),
    intOrNull(e.actor_id),
    e.actor_name ?? null,
    e.due_at ?? null,
    intOrNull(e.reverts_id),
  );
}

export function applyChange(db, item, touched) {
  const type = item.type;
  if (type === "request.created" || type === "request.updated" || type === "request.deleted") {
    if (item.request) {
      upsertRequest(db, item.request);
      touched?.add(Number(item.request.id));
    }
  } else if (type === "event.created") {
    if (item.event) {
      const rid = item.request_id ?? item.event.request_id;
      upsertEvent(db, rid, item.event);
      touched?.add(Number(rid));
    }
  } else if (type === "staff.updated" || type === "staff.created") {
    const s = item.staff;
    if (s && s.id !== undefined) {
      db.prepare(
        "INSERT INTO staff (id, name) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name",
      ).run(Number(s.id), s.name ?? null);
    }
  } else if (type === "site.updated" || type === "site.created") {
    const s = item.site;
    if (s && s.id !== undefined) upsertSite(db, s);
  } else {
    // Unknown types: log once, don't crash — a new change type is exactly the
    // kind of live surprise the brief warns about. Config refresh re-pulls
    // sites/staff anyway, so those stay fresh regardless.
    if (!applyChange.seenUnknown) applyChange.seenUnknown = new Set();
    if (!applyChange.seenUnknown.has(type)) {
      console.warn(`sync: ignoring unknown change type ${JSON.stringify(type)}`);
      applyChange.seenUnknown.add(type);
    }
  }
}

// Applies a page of change items (upserts, idempotent) and refreshes the
// materialized report rows for every touched request. Returns the touched ids.
export function applyChanges(db, items) {
  const touched = new Set();
  db.exec("BEGIN");
  try {
    for (const item of items) applyChange(db, item, touched);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  materializeRows(db, touched);
  return touched;
}

// Sites, holidays and staff come from their own endpoints (the change feed is
// about requests). Re-fetch every minute: staff names must be *current* names
// (rule 3), and site config can change under us.
export async function refreshConfig(client, db, logger = console) {
  const sites = await client.get("/v1/sites");
  for (const s of sites.data ?? []) upsertSite(db, s);
  for (const s of sites.data ?? []) {
    const holidays = await client.get(`/v1/sites/${s.id}/holidays`);
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM holidays WHERE site_id = ?").run(Number(s.id));
      for (const h of holidays.data ?? []) {
        db.prepare("INSERT OR REPLACE INTO holidays (site_id, date, name) VALUES (?, ?, ?)").run(
          Number(s.id),
          String(h.date ?? "").trim(),
          h.name ?? null,
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  const staff = await client.get("/v1/staff");
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM staff");
    for (const p of staff.data ?? []) {
      db.prepare("INSERT OR REPLACE INTO staff (id, name) VALUES (?, ?)").run(
        Number(p.id),
        p.name ?? null,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return (sites.data ?? []).length;
}

// Walk the change feed from `startCursor` (or the very beginning) until caught
// up, returning the cursor to resume from. A 410 means cursors expired
// mid-walk; we restart from the beginning — every upsert is idempotent, so
// overlapping application is safe (just slower).
export async function walkChanges(client, db, startCursor, logger = console) {
  let cursor = startCursor;
  for (;;) {
    let res;
    try {
      res = await client.get("/v1/changes", { limit: CHANGES_PAGE, cursor });
    } catch (err) {
      if (String(err && err.message).includes("410")) {
        logger.warn("sync: change cursor expired (410); restarting walk from the beginning");
        cursor = undefined;
        continue;
      }
      throw err;
    }
    const items = res.data ?? [];
    applyChanges(db, items); // applies + materializes touched rows
    if (items.length > 0) {
      const maxSeq = Math.max(...items.map((c) => Number(c.seq ?? 0)));
      setState(db, "last_seq", String(Math.max(Number(getState(db, "last_seq", "0")) || 0, maxSeq)));
    }
    logger.log(`sync: ${Number(getState(db, "last_seq", "0"))} changes applied`);
    const hadMore = res.has_more === true;
    cursor = res.next_cursor ?? undefined;
    if (!hadMore) return cursor;
  }
}

export async function backfill(client, db, logger = console) {
  const resume = getState(db, "cursor");
  const t0 = Date.now();
  const finalCursor = await walkChanges(client, db, resume ?? undefined, logger);
  if (finalCursor) setState(db, "cursor", finalCursor);
  logger.log(`sync: backfill caught up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return finalCursor;
}

// Tails the feed forever. Fire-and-forget; errors are logged and retried, never
// allowed to kill the process. Returns a handle with stop() (tests use it).
export function startTail(client, db, cursor0, logger = console, idleMs = TAIL_IDLE_MS) {
  const control = { stopped: false, stop() { control.stopped = true; } };
  (async () => {
    let cursor = cursor0;
    while (!control.stopped) {
      try {
        cursor = await walkChanges(client, db, cursor, logger);
        if (cursor) setState(db, "cursor", cursor);
        await new Promise((r) => setTimeout(r, control.stopped ? 0 : idleMs));
      } catch (err) {
        logger.error(`sync tail error: ${err && err.message}`);
        await new Promise((r) => setTimeout(r, TAIL_ERROR_MS));
      }
    }
  })();
  return control;
}

// One-shot boot sequence: config, backfill, rebuild rows, ready, tail.
// Returns the tail control handle so tests can stop it; the daemon config
// refresh lives in server.js.
export async function runSync(client, db, state, logger = console) {
  await refreshConfig(client, db, logger);
  await backfill(client, db, logger);
  // Rebuild all rows once: keeps resumed stores (cursor already advanced,
  // nothing re-applied) consistent with the synced tables.
  const t1 = Date.now();
  const n = materializeAll(db);
  logger.log(`sync: rebuilt ${n} report rows in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  state.ready = true;
  logger.log("sync: ready (backfill complete)");
  return startTail(client, db, getState(db, "cursor") ?? undefined, logger);
}
