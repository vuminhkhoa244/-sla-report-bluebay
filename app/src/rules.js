// The seven rules of docs/rules.md, operating on the synced SQLite copy.
// Pure-ish and fully synchronous: SQLite via node:sqlite is sync, so two
// concurrent HTTP requests can never interleave inside one report computation.
import { zonedParts, localDateStr, businessSecondsBetween, zonedToEpochSec, pad2 } from "./time.js";

const TARGET_MINUTES = { High: 60, Medium: 240, Low: 480, null: 480 }; // rule 5; null priority is Low

// Defensive on priority casing ("high" vs "High"); unknown values behave like
// null (480) — documented in DECISIONS.md.
function targetFor(priority) {
  if (priority === null || priority === undefined) return TARGET_MINUTES.null;
  const key = String(priority).trim();
  const known = key in TARGET_MINUTES ? key : key[0].toUpperCase() + key.slice(1).toLowerCase();
  if (known in TARGET_MINUTES) return TARGET_MINUTES[known];
  return TARGET_MINUTES.null;
}

export function buildLookups(db) {
  const sites = new Map(); // id -> {timezone, hours}
  for (const s of db.prepare("SELECT id, timezone, business_hours FROM sites").all()) {
    let hours = null;
    try {
      hours = s.business_hours ? JSON.parse(s.business_hours) : null;
    } catch {
      hours = null;
    }
    sites.set(Number(s.id), { timezone: s.timezone, hours });
  }
  const holidays = new Map(); // site_id -> Set("YYYY-MM-DD"), site-local calendar days
  for (const h of db.prepare("SELECT site_id, date FROM holidays").all()) {
    let set = holidays.get(Number(h.site_id));
    if (!set) holidays.set(Number(h.site_id), (set = new Set()));
    set.add(normalizeHoliday(h.date));
  }
  const staff = new Map(); // id -> current name (rule 3: use /v1/staff names, never event actor_name)
  for (const p of db.prepare("SELECT id, name FROM staff").all()) {
    staff.set(Number(p.id), p.name);
  }
  return { sites, holidays, staff };
}

// Holidays arrive as "DD/MM/YYYY" (site docs) — the report only ever compares
// them to local date strings "YYYY-MM-DD", so normalize once, here.
export function normalizeHoliday(raw) {
  const s = String(raw ?? "").trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return s;
  return s; // unknown format: keep raw; holiday matching will simply miss
}

// Rule 2: an event with reverts_id undoes the target event — drop BOTH.
export function retainableEvents(events) {
  const reverted = new Set();
  for (const e of events) if (e.reverts_id !== null && e.reverts_id !== undefined) reverted.add(e.reverts_id);
  return events.filter((e) => !reverted.has(e.id) && e.reverts_id === null);
}

// "DD/MM/YYYY HH:mm", site-local wall clock (rule 6) -> epoch seconds.
export function parseDueAt(dueAt, tz) {
  if (dueAt === null || dueAt === undefined) return null;
  const m = String(dueAt).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (m) {
    const [, dd, mm, yyyy, hh, mi] = m;
    return zonedToEpochSec(`${yyyy}-${mm}-${dd}`, `${hh}:${mi}`, tz);
  }
  // Defensive: the docs promise this format, but aISOs happen. Note in DECISIONS
  // if the practice data ever deviates.
  const iso = Date.parse(String(dueAt));
  return Number.isFinite(iso) ? Math.floor(iso / 1000) : null;
}

export function firstResponse(events) {
  // Earliest processing event with a human actor (rule 3). System events have
  // actor_id null. Tie on `at` -> lower event id (stable, deterministic).
  let best = null;
  for (const e of events) {
    if (e.status !== "processing" || e.actor_id === null || e.actor_id === undefined) continue;
    if (
      best === null ||
      e.at < best.at ||
      (e.at === best.at && e.id < best.id)
    ) {
      best = e;
    }
  }
  return best;
}

export function lastComplete(events) {
  // Last complete event (rule 6): latest `at`; tie -> higher event id is later.
  let best = null;
  for (const e of events) {
    if (e.status !== "complete") continue;
    if (best === null || e.at > best.at || (e.at === best.at && e.id > best.id)) best = e;
  }
  return best;
}

export function latestDeadline(events) {
  // The deadline is the due_at of the LATEST event that has one (rule 6) — not
  // the request's current due_on, and not the last event's due_at.
  let best = null;
  for (const e of events) {
    if (e.due_at === null || e.due_at === undefined || e.due_at === "") continue;
    if (best === null || e.at > best.at || (e.at === best.at && e.id > best.id)) best = e;
  }
  return best?.due_at ?? null;
}

// Computes one row of the report for a request (+ its retained events).
export function computeRow(req, events, lookups) {
  const site = lookups.sites.get(req.site_id);
  const tz = site?.timezone ?? "UTC"; // unknown site: UTC fallback, logged upstream
  const hours = site?.hours ?? null;
  const holidays = lookups.holidays.get(req.site_id) ?? new Set();

  const first = firstResponse(events);
  let responseBusinessMinutes = null;
  if (first) {
    const secs = businessSecondsBetween(tz, hours, holidays, req.created_at, first.at);
    responseBusinessMinutes = Math.floor(Math.max(secs, 0) / 60); // rule 4: 0 if response earlier than created
  }

  const target = targetFor(req.priority);
  const withinTarget = responseBusinessMinutes === null ? null : responseBusinessMinutes <= target;

  let completedLate = null; // rule 7: never completed or no deadline -> null
  const lastCompleteEv = lastComplete(events);
  if (lastCompleteEv) {
    const deadline = latestDeadline(events);
    if (deadline !== null) {
      const dueSec = parseDueAt(deadline, tz);
      if (dueSec !== null) completedLate = lastCompleteEv.at > dueSec; // strictly after
    }
  }

  return {
    id: req.id,
    site_id: req.site_id,
    responder_id: first ? first.actor_id : null,
    responder: first ? (lookups.staff.get(first.actor_id) ?? null) : null,
    response_business_minutes: responseBusinessMinutes,
    within_target: withinTarget,
    completed_late: completedLate,
  };
}

// Epoch window [min, max] in which a request's created_at must fall for its
// SITE-LOCAL date (rule 1) to possibly lie in [from, to].
function epochWindow(lookups, from, to) {
  const moments = [];
  for (const { timezone } of lookups.sites.values()) {
    if (!timezone) continue;
    moments.push(zonedToEpochSec(from, "00:00", timezone));
    moments.push(zonedToEpochSec(to, "23:59:59", timezone));
  }
  // Sites not yet synced would break the window's correctness; fall back wide.
  if (moments.length === 0) {
    return [Date.parse(`${from}T00:00:00Z`) / 1000 - 50400, Date.parse(`${to}T23:59:59Z`) / 1000 + 50400];
  }
  return [Math.min(...moments) - 86400, Math.max(...moments) + 86400];
}

export function computeSlaReport(db, { from, to }) {
  const lookups = buildLookups(db);
  const [lo, hi] = epochWindow(lookups, from, to);

  const candidates = db
    .prepare(
      `SELECT id, site_id, status, priority, created_at, deleted_at, merged_into_id
       FROM requests WHERE created_at IS NOT NULL AND created_at >= ? AND created_at <= ?`,
    )
    .all(lo, hi);

  const rows = [];
  for (const req of candidates) {
    const p = zonedParts(req.created_at, lookups.sites.get(req.site_id)?.timezone ?? "UTC");
    const localDate = localDateStr(p);
    if (localDate < from || localDate > to) continue; // rule 1, exact
    if (req.status === "canceled" || req.deleted_at !== null || req.merged_into_id !== null) continue; // rule 1
    rows.push(req);
  }

  // Events for exactly the surviving requests, via a temp scope table (12k+ IN
  // params is past most SQLite variable limits; a join table is now size-proof).
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS report_scope (request_id INTEGER PRIMARY KEY);
           DELETE FROM report_scope`);
  db.exec("BEGIN");
  try {
    const ins = db.prepare("INSERT OR IGNORE INTO report_scope VALUES (?)");
    for (const r of rows) ins.run(r.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  const eventsByReq = new Map();
  for (const e of db
    .prepare(
      `SELECT e.request_id, e.id, e.status, e.at, e.actor_id, e.due_at, e.reverts_id
       FROM events e JOIN report_scope s ON e.request_id = s.request_id ORDER BY e.request_id, e.at, e.id`,
    )
    .all()) {
    let list = eventsByReq.get(e.request_id);
    if (!list) eventsByReq.set(e.request_id, (list = []));
    list.push(e);
  }

  const outRows = [];
  const responders = new Map(); // responder_id -> summary (rule 3 responder keys)
  for (const req of rows) {
    const evts = retainableEvents(eventsByReq.get(req.id) ?? []);
    const row = computeRow(req, evts, lookups);
    outRows.push(row);
    if (row.responder_id !== null) {
      let agg = responders.get(row.responder_id);
      if (!agg) responders.set(row.responder_id, (agg = { id: row.responder_id, name: row.responder, requests: 0, within_target: 0, completed_late: 0 }));
      agg.requests++;
      if (row.within_target === true) agg.within_target++;
      if (row.completed_late === true) agg.completed_late++;
    }
  }

  return {
    from,
    to,
    requests: outRows,
    responders: [...responders.values()],
  };
}
