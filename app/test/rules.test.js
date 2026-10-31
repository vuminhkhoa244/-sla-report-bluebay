import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import {
  businessSecondsBetween,
  zonedToEpochSec,
  zonedParts,
  localDateStr,
} from "../src/time.js";
import {
  computeSlaReport,
  retainableEvents,
  parseDueAt,
  normalizeHoliday,
  materializeAll,
} from "../src/rules.js";

// --- time.js -------------------------------------------------------------

const SG = "Asia/Singapore"; // UTC+8, no DST
const SYD = "Australia/Sydney"; // UTC+10, springs forward in October

test("zonedParts/zonedToEpochSec round-trip across zones", () => {
  const epoch = Date.parse("2026-10-06T02:15:07Z") / 1000;
  const p = zonedParts(epoch, SG);
  assert.deepEqual([[p.y, p.mo, p.d], [p.h, p.mi, p.s]], [[2026, 10, 6], [10, 15, 7]]);
  assert.equal(
    zonedToEpochSec(localDateStr(p), `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}:${String(p.s).padStart(2, "0")}`, SG),
    epoch,
  );
});

test("Sydney spring-forward day is handled (2026: clocks jump 2:00 -> 3:00)", () => {
  const p = zonedParts(zonedToEpochSec("2026-10-04", "09:30", SYD), SYD);
  assert.deepEqual([p.h, p.mi], [9, 30]);
  // 02:30 does not exist that day; the algorithm must still return an instant
  const any = zonedToEpochSec("2026-10-04", "02:30", SYD);
  assert.equal(Number.isFinite(any), true);
  assert.equal(zonedParts(any, SYD).h >= 2, true);
});

test("businessSecondsBetween: basic day, edges, closed days, holidays", () => {
  const mon = { mon: { open: "08:00", close: "18:00" }, sun: null };
  const t = (d, h) => zonedToEpochSec(d, h, SG);
  const emptyHolidays = new Set();

  // Same full working day 08:00-18:00 = 10h = 36000s
  assert.equal(businessSecondsBetween(SG, mon, emptyHolidays, t("2026-10-05", "08:00"), t("2026-10-05", "18:00")), 36000);
  // Partial: 09:00-13:30 = 4.5h
  assert.equal(businessSecondsBetween(SG, mon, emptyHolidays, t("2026-10-05", "09:00"), t("2026-10-05", "13:30")), 16200);
  // Created before opening; response after opening: counts from 08:00
  assert.equal(businessSecondsBetween(SG, mon, emptyHolidays, t("2026-10-05", "06:00"), t("2026-10-05", "09:00")), 3600);
  // Sunday closed
  assert.equal(businessSecondsBetween(SG, mon, emptyHolidays, t("2026-10-04", "08:00"), t("2026-10-04", "18:00")), 0);
  // Holiday closed all day
  assert.equal(businessSecondsBetween(SG, mon, new Set(["2026-10-05"]), t("2026-10-05", "08:00"), t("2026-10-05", "18:00")), 0);
  // Response earlier than created_at -> 0 (rule 4)
  assert.equal(businessSecondsBetween(SG, mon, emptyHolidays, t("2026-10-05", "10:00"), t("2026-10-05", "09:00")), 0);
  // Overnight Mon 16:00 -> Tue 11:00 = 2h + 3h = 5h
  assert.equal(
    businessSecondsBetween(SG, { mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" }, sun: null, sat: null }, emptyHolidays, t("2026-10-05", "16:00"), t("2026-10-06", "11:00")),
    18000,
  );
  // Sun then Mon: closed Sunday skipped
  assert.equal(
    businessSecondsBetween(SG, { mon: { open: "09:00", close: "10:00" }, sun: null }, emptyHolidays, t("2026-10-04", "08:00"), t("2026-10-05", "09:30")),
    1800,
  );
});

test("sum seconds THEN floor: 45s on two separate days floors once at the end", () => {
  const mon = { mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" } };
  const t = (d, h) => zonedToEpochSec(d, h, SG);
  const secs = businessSecondsBetween(SG, mon, new Set(), t("2026-10-05", "17:59:50"), t("2026-10-06", "08:00:35"));
  // 10s on Monday + 35s on chargeTuesday = 45 raw seconds → 0 floored minutes
  assert.equal(secs, 45);
  assert.equal(Math.floor(secs / 60), 0);
});

// --- rules.js helpers ----------------------------------------------------

test("retainableEvents drops the reverted event AND the reverting event (rule 2)", () => {
  const evts = [
    { id: 1, status: "pending", at: 100, actor_id: null, reverts_id: null },
    { id: 2, status: "processing", at: 200, actor_id: 304, reverts_id: null },
    { id: 3, status: "pending", at: 300, actor_id: null, reverts_id: null },
    { id: 4, status: "pending", at: 400, actor_id: null, reverts_id: 2 },
  ];
  const kept = retainableEvents(evts);
  assert.deepEqual(kept.map((e) => e.id), [1, 3]);
});

test("parseDueAt reads DD/MM/YYYY HH:mm as SITE-LOCAL wall clock (rule 6)", () => {
  // 07/10/2026 10:00 in Singapore = 2026-10-07T02:00:00Z
  assert.equal(parseDueAt("07/10/2026 10:00", SG), Date.parse("2026-10-07T02:00:00Z") / 1000);
  assert.equal(parseDueAt(null, SG), null);
});

test("normalizeHoliday accepts DD/MM/YYYY and ISO", () => {
  assert.equal(normalizeHoliday("10/08/2026"), "2026-08-10");
  assert.equal(normalizeHoliday("2026-08-10"), "2026-08-10");
});

// --- computeSlaReport end-to-end on a synthetic store ---------------------

function seed(db, overrides = {}) {
  const { requests = [], events = [], staff = [], sites = [], holidays = [] } = overrides;
  db.exec("SAVEPOINT seed");
  for (const s of sites) {
    db.prepare("INSERT INTO sites (id, name, timezone, business_hours) VALUES (?, ?, ?, ?)").run(
      s.id, s.name ?? "", s.timezone, JSON.stringify(s.hours ?? null),
    );
  }
  for (const h of holidays) db.prepare("INSERT INTO holidays (site_id, date, name) VALUES (?, ?, ?)").run(h.site_id, h.date, "");
  for (const p of staff) db.prepare("INSERT INTO staff (id, name) VALUES (?, ?)").run(p.id, p.name);
  for (const r of requests) {
    db.prepare(
      `INSERT INTO requests (id, ref, title, site_id, status, priority, created_at, updated_at, due_on,
         assignee_id, deleted_at, merged_into_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, "", "", r.site_id ?? 11, r.status ?? "processing", r.priority ?? "High",
      ts(r.created_at), null, null, null, r.deleted_at ? ts(r.deleted_at) : null, r.merged_into_id ?? null);
  }
  for (const e of events) {
    db.prepare(
      "INSERT INTO events (request_id, id, status, at, actor_id, actor_name, due_at, reverts_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(e.request_id, e.id, e.status, ts(e.at), e.actor_id ?? null, "", e.due_at ?? null, e.reverts_id ?? null);
  }
  db.exec("RELEASE seed");
  materializeAll(db); // rules tests read the materialized rows now
}

const ts = (s) => (typeof s === "number" ? s : Date.parse(s) / 1000);

function mkdb() {
  return openDb(":memory:");
}

const SITE_SG = {
  id: 11,
  timezone: "Asia/Singapore",
  hours: { mon: { open: "08:00", close: "18:00" }, tue: { open: "08:00", close: "18:00" }, wed: { open: "08:00", close: "18:00" }, thu: { open: "08:00", close: "18:00" }, fri: { open: "08:00", close: "18:00" }, sat: null, sun: null },
};

test("full report: happy-path High-priority request within target", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    staff: [{ id: 304, name: "Benjamin Tan" }],
    requests: [{ id: 1, created_at: "2026-10-05T02:15:07Z" }], // Mon 10:15 local
    events: [
      { request_id: 1, id: 10, status: "pending", at: "2026-10-05T02:15:07Z", actor_id: null },
      { request_id: 1, id: 11, status: "processing", at: "2026-10-05T02:57:07Z", actor_id: 304, actor_name: "Stale Name" }, // 10:57 local, 42 business minutes
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-05" });
  assert.equal(rep.requests.length, 1);
  const r = rep.requests[0];
  assert.equal(r.responder_id, 304);
  assert.equal(r.responder, "Benjamin Tan"); // current staff name, NOT event actor_name (rule 3)
  assert.equal(r.response_business_minutes, 42);
  assert.equal(r.within_target, true); // 42 <= 60 (High)
  assert.equal(r.completed_late, null); // never completed
  assert.deepEqual(rep.responders, [{ id: 304, name: "Benjamin Tan", requests: 1, within_target: 1, completed_late: 0 }]);
});

test("reverting the first processing event erases the responder (rule 2 + nulls rule 7)", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    staff: [{ id: 304, name: "Benjamin Tan" }],
    requests: [{ id: 1, created_at: "2026-10-05T02:15:07Z" }],
    events: [
      { request_id: 1, id: 10, status: "processing", at: "2026-10-05T02:50:07Z", actor_id: 304 },
      { request_id: 1, id: 11, status: "pending", at: "2026-10-05T02:55:07Z", actor_id: null, reverts_id: 10 },
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-05" });
  const r = rep.requests[0];
  assert.equal(r.responder_id, null);
  assert.equal(r.responder, null);
  assert.equal(r.response_business_minutes, null);
  assert.equal(r.within_target, null);
  assert.equal(r.completed_late, null);
  assert.equal(rep.responders.length, 0);
});

test("completed after event deadline => completed_late true; reopened later still uses last complete (rule 6)", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    staff: [{ id: 304, name: "Benjamin Tan" }],
    requests: [{ id: 1, created_at: "2026-10-05T02:15:07Z", priority: "Medium" }],
    events: [
      { request_id: 1, id: 10, status: "processing", at: "2026-10-05T02:45:07Z", actor_id: 304, due_at: "05/10/2026 18:00" },
      { request_id: 1, id: 11, status: "complete", at: "2026-10-05T11:30:00Z", actor_id: 304 }, // 19:30 local > 18:00 local deadline
      { request_id: 1, id: 12, status: "processing", at: "2026-10-05T12:00:00Z", actor_id: 200 }, // reopened after completion
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-05" });
  const r = rep.requests[0];
  assert.equal(r.completed_late, true);
});

test("deadline comes from the LATEST event that has one, not the newest event (rule 6)", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    staff: [{ id: 304, name: "Benjamin Tan" }],
    requests: [{ id: 1, created_at: "2026-10-05T02:15:07Z", priority: "High" }],
    events: [
      { request_id: 1, id: 10, status: "processing", at: "2026-10-05T02:20:07Z", actor_id: 304 },
      { request_id: 1, id: 11, status: "processing", at: "2026-10-05T02:30:07Z", actor_id: 304, due_at: "06/10/2026 12:00" },
      { request_id: 1, id: 12, status: "note", at: "2026-10-05T03:00:07Z", actor_id: null }, // newest but no due_at
      { request_id: 1, id: 13, status: "complete", at: "2026-10-06T04:30:00Z", actor_id: 304 }, // 12:30 local on 6 Oct
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-06" });
  assert.equal(rep.requests[0].completed_late, true); // 12:30 > 12:00 deadline set by event 11
});

test("range filter is SITE-LOCAL date (rule 1): Singapore 20:05 UTC is next day", () => {
  const db = mkdb();
  // created_at 2026-10-31T20:05:00Z => Singapore local 01 Nov 04:05; Jakarta local 01 Nov 03:05
  seed(db, {
    sites: [SITE_SG, { id: 12, timezone: "Asia/Jakarta", hours: null }],
    requests: [
      { id: 1, site_id: 11, created_at: "2026-10-31T20:05:00Z" },
      { id: 2, site_id: 12, created_at: "2026-10-31T16:30:00Z" }, // Jakarta 31 Oct 23:30 -> in range
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(rep.requests.map((r) => r.id), [2]);
});

test("canceled, deleted and merged requests are skipped (rule 1)", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    requests: [
      { id: 1, created_at: "2026-10-05T02:00:00Z", status: "canceled" },
      { id: 2, created_at: "2026-10-05T02:00:00Z", deleted_at: "2026-10-05T03:00:00Z" },
      { id: 3, created_at: "2026-10-05T02:00:00Z", merged_into_id: 99 },
      { id: 4, created_at: "2026-10-05T02:00:00Z" }, // only this one counts
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-05" });
  assert.deepEqual(rep.requests.map((r) => r.id), [4]);
});

test("responders summary aggregates within_target and completed_late counts", () => {
  const db = mkdb();
  seed(db, {
    sites: [SITE_SG],
    staff: [{ id: 304, name: "Benjamin Tan" }, { id: 305, name: "Ana Wijaya" }],
    requests: [
      { id: 1, created_at: "2026-10-05T02:00:00Z", priority: "High" },
      { id: 2, created_at: "2026-10-05T02:00:00Z", priority: "Low" },
      { id: 3, created_at: "2026-10-05T02:00:00Z", priority: "Medium" },
    ],
    events: [
      { request_id: 1, id: 10, status: "processing", at: "2026-10-05T02:10:00Z", actor_id: 304 }, // 10 min within
      { request_id: 1, id: 11, status: "complete", at: "2026-10-05T02:20:00Z", actor_id: 304, due_at: "05/10/2026 09:15" }, // 10:20 local > 09:15 late
      { request_id: 2, id: 20, status: "processing", at: "2026-10-05T03:00:00Z", actor_id: 305 }, // 60 min: within for Low
      { request_id: 2, id: 21, status: "complete", at: "2026-10-05T04:00:00Z", actor_id: 305, due_at: "05/10/2026 17:00" }, // 12:00 < 17:00 on time
      { request_id: 3, id: 30, status: "processing", at: "2026-10-05T09:00:00Z", actor_id: 304 }, // 7h (02:00 -> 17:00 local? actually 10:00-17:00 = 420 min) > 240 out
    ],
  });
  const rep = computeSlaReport(db, { from: "2026-10-05", to: "2026-10-05" });
  const benj = rep.responders.find((x) => x.id === 304);
  const ana = rep.responders.find((x) => x.id === 305);
  assert.deepEqual(benj, { id: 304, name: "Benjamin Tan", requests: 2, within_target: 1, completed_late: 1 });
  assert.deepEqual(ana, { id: 305, name: "Ana Wijaya", requests: 1, within_target: 1, completed_late: 0 });
  const r3 = rep.requests.find((r) => r.id === 3);
  assert.equal(r3.within_target, false);
});
