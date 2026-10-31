// Shared fixtures for the browse/CSV test files: two sites (Singapore plain,
// Sydney mid-DST) and five requests whose rule outcomes are hand-computed in
// the comment below. seed() gives a fully materialized :memory: store.
import { openDb } from "../src/db.js";
import { materializeAll } from "../src/rules.js";

export const SITES = [
  {
    id: 11,
    timezone: "Asia/Singapore", // Mon-Fri 08:00-18:00
    hours: {
      mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" },
      wed: { open: "08:00", close: "18:00" }, thu: { open: "08:00", close: "18:00" },
      fri: { open: "08:00", close: "18:00" }, sat: null, sun: null,
    },
  },
  {
    id: 12,
    timezone: "Australia/Sydney", // DST: Oct 2026 is UTC+11; Mon-Fri 07:30-17:00
    hours: {
      mon: { open: "07:30", close: "17:00" }, tue: { open: "07:30", close: "17:00" },
      wed: { open: "07:30", close: "17:00" }, thu: { open: "07:30", close: "17:00" },
      fri: { open: "07:30", close: "17:00" }, sat: null, sun: null,
    },
  },
];

export const TZ_OF = { 11: "Asia/Singapore", 12: "Australia/Sydney" };

// "05/10/2026 17:30" site-local wall clock -> epoch seconds (double-pass offset,
// same algorithm as src/time.js; independent reimplementation for the test).
export function tzWall(wall, siteId) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(wall);
  const tz = TZ_OF[siteId];
  const asUtc = Date.UTC(m[3], m[2] - 1, m[1], m[4], m[5], 0) / 1000;
  const offset = (epoch) => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(epoch * 1000));
    const o = {};
    for (const x of p) o[x.type] = x.value;
    return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) / 1000 - epoch;
  };
  const off1 = offset(asUtc);
  let epoch = asUtc - off1;
  const off2 = offset(epoch);
  if (off2 !== off1) epoch = asUtc - off2;
  return epoch;
}

/*
 * Expected outcomes (hand-computed):
 *  101: created Mon 05 Oct 10:00 SG. resp 10:10 -> 10 min, within (High<=60).
 *       complete 17:30 <= due 18:00 -> on time.
 *  102: created Mon 10:00 SG. resp 11:00 -> 60 min, within. complete 18:30 > 18:00 -> late.
 *  103: created 2026-10-05T20:00Z is Mon 06 Oct 07:00 Sydney (DST+11).
 *       resp 11:30 -> business from 07:30 = 240 min, within (Medium<=240).
 *       complete 12:30 > due 12:00 -> late.
 *  104: no human processing event, no complete -> all nulls.
 *  105: created Mon 10:00 SG. resp Wed 07 Oct 09:00 -> Mon 480 + Tue 600 + Wed 60 = 1140 min,
 *       out of target (null priority -> 480). complete Wed 10:00 > due Mon 18:00 -> late.
 */
export const FIXTURES = [
  { id: 101, site: 11, created: "2026-10-05T02:00:00Z", priority: "High",
    resp: { at: "05/10/2026 10:10", actor: 304 }, due: "05/10/2026 18:00", complete: "05/10/2026 17:30" },
  { id: 102, site: 11, created: "2026-10-05T02:00:00Z", priority: "High",
    resp: { at: "05/10/2026 11:00", actor: 304 }, due: "05/10/2026 18:00", complete: "05/10/2026 18:30" },
  { id: 103, site: 12, created: "2026-10-05T20:00:00Z", priority: "Medium",
    resp: { at: "06/10/2026 11:30", actor: 305 }, due: "06/10/2026 12:00", complete: "06/10/2026 12:30" },
  { id: 104, site: 12, created: "2026-10-05T20:00:00Z", priority: "Low", resp: null },
  { id: 105, site: 11, created: "2026-10-05T02:00:00Z", priority: null,
    resp: { at: "07/10/2026 09:00", actor: 304 }, due: "05/10/2026 18:00", complete: "07/10/2026 10:00" },
];

export function seed() {
  const db = openDb(":memory:");
  for (const s of SITES) {
    db.prepare("INSERT INTO sites (id, name, timezone, business_hours) VALUES (?, ?, ?, ?)").run(
      s.id, "", s.timezone, JSON.stringify(s.hours),
    );
  }
  for (const p of [{ id: 304, name: "Benjamin Tan" }, { id: 305, name: "Ana Wijaya" }]) {
    db.prepare("INSERT INTO staff (id, name) VALUES (?, ?)").run(p.id, p.name);
  }
  db.exec("BEGIN");
  const insReq = db.prepare(
    `INSERT INTO requests (id, ref, title, site_id, status, priority, created_at, updated_at, due_on,
       assignee_id, deleted_at, merged_into_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEv = db.prepare(
    "INSERT INTO events (request_id, id, status, at, actor_id, actor_name, due_at, reverts_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (const f of FIXTURES) {
    insReq.run(f.id, "", "", f.site, f.resp ? "processing" : "pending", f.priority,
      Date.parse(f.created) / 1000, null, null, null, null, null);
    insEv.run(f.id, f.id * 10, "pending", Date.parse(f.created) / 1000, null, "System", f.due ?? null, null);
    if (f.resp) {
      insEv.run(f.id, f.id * 10 + 1, "processing", tzWall(f.resp.at, f.site), f.resp.actor, "Stale Name", null, null);
      insEv.run(f.id, f.id * 10 + 3, "complete", tzWall(f.complete, f.site), f.resp.actor, "", null, null);
    }
  }
  db.exec("COMMIT");
  materializeAll(db);
  return db;
}
