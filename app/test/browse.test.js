import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { materializeAll, materializeRows, computeSlaReport } from "../src/rules.js";
import { browseRows } from "../src/queries.js";
import { BadInput as BadInputError } from "../src/validate.js";

// A cursor carrying a null metric key is legal (null-metric page boundary)...

const SITES = [
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

const TZ_OF = { 11: "Asia/Singapore", 12: "Australia/Sydney" };

// "05/10/2026 17:30" site-local wall clock -> epoch seconds (double-pass offset,
// same algorithm as src/time.js; independent reimplementation for the test).
function tzWall(wall, siteId) {
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
 *  103: created Sat 05 Oct... no: 2026-10-05T20:00Z is Mon 06 Oct 07:00 Sydney (DST+11).
 *       resp 11:30 -> business from 07:30 = 240 min, within (Medium<=240).
 *       complete 12:30 > due 12:00 -> late.
 *  104: no human processing event, no complete -> all nulls.
 *  105: created Mon 10:00 SG. resp Wed 07 Oct 09:00 -> Mon 480 + Tue 600 + Wed 60 = 1140 min,
 *       out of target (null priority -> 480). complete Wed 10:00 > due Mon 18:00 -> late.
 */
const FIXTURES = [
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

function seed() {
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

test("materialized report rows match hand-computed expectations", () => {
  const db = seed();
  const rep = computeSlaReport(db, { from: "2026-10-01", to: "2026-10-31" });
  const want = {
    101: { responder_id: 304, responder: "Benjamin Tan", response_business_minutes: 10, within_target: true, completed_late: false },
    102: { responder_id: 304, responder: "Benjamin Tan", response_business_minutes: 60, within_target: true, completed_late: true },
    103: { responder_id: 305, responder: "Ana Wijaya", response_business_minutes: 240, within_target: true, completed_late: true },
    104: { responder_id: null, responder: null, response_business_minutes: null, within_target: null, completed_late: null },
    105: { responder_id: 304, responder: "Benjamin Tan", response_business_minutes: 1140, within_target: false, completed_late: true },
  };
  assert.equal(rep.requests.length, 5);
  for (const [id, w] of Object.entries(want)) {
    const row = rep.requests.find((r) => r.id === Number(id));
    for (const [k, v] of Object.entries(w)) {
      assert.deepEqual(row[k], v, `request ${id} field ${k}`);
    }
  }
  const benj = rep.responders.find((x) => x.id === 304);
  assert.deepEqual(benj, { id: 304, name: "Benjamin Tan", requests: 3, within_target: 2, completed_late: 2 });
  const ana = rep.responders.find((x) => x.id === 305);
  assert.deepEqual(ana, { id: 305, name: "Ana Wijaya", requests: 1, within_target: 1, completed_late: 1 });
});

test("browse walk: id sorts hit every row exactly once in order", () => {
  const db = seed();
  const walk = (sort) => {
    const seen = [];
    let cursor;
    for (;;) {
      const q = { from: "2026-10-01", to: "2026-10-31", sort, limit: "2" };
      if (cursor) q.cursor = cursor;
      const page = browseRows(db, q);
      seen.push(...page.data.map((r) => r.id));
      if (page.next_cursor === null) return seen;
      cursor = page.next_cursor;
    }
  };
  assert.deepEqual(walk("id"), [101, 102, 103, 104, 105]);
  assert.deepEqual(walk("-id"), [105, 104, 103, 102, 101]);
});

test("browse: response_business_minutes sorts, nulls last, ties by id asc", () => {
  const db = seed();
  const q = { from: "2026-10-01", to: "2026-10-31", sort: "response_business_minutes", limit: "200" };
  const asc = browseRows(db, q);
  assert.deepEqual(
    asc.data.map((r) => [r.response_business_minutes, r.id]),
    [[10, 101], [60, 102], [240, 103], [1140, 105], [null, 104]],
  );
  // full keyset walk in desc order too (exercises the tuple cursor)
  const seen = [];
  let cursor;
  for (;;) {
    const page = browseRows(db, cursor ? { ...q, sort: "-response_business_minutes", cursor } : { ...q, sort: "-response_business_minutes" });
    seen.push(...page.data.map((r) => [r.response_business_minutes, r.id]));
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(seen, [[1140, 105], [240, 103], [60, 102], [10, 101], [null, 104]]);
});

test("browse: each filter narrows exactly as specified", () => {
  const db = seed();
  const run = (extra) =>
    browseRows(db, { from: "2026-10-01", to: "2026-10-31", ...extra }).data.map((r) => r.id);
  assert.deepEqual(run({ site_id: "12" }), [103, 104]);
  assert.deepEqual(run({ responder_id: "304" }), [101, 102, 105]);
  assert.deepEqual(run({ late: "true" }), [102, 103, 105]);
  assert.deepEqual(run({ late: "false" }), [101]);
  assert.deepEqual(run({ within_target: "false" }), [105]);
  assert.deepEqual(run({ within_target: "true" }), [101, 102, 103]);
});

test("browse: paging respects limit and next_cursor on filtered pages", () => {
  const db = seed();
  const p1 = browseRows(db, { from: "2026-10-01", to: "2026-10-31", late: "true", limit: "2" });
  assert.deepEqual(p1.data.map((r) => r.id), [102, 103]);
  assert.notEqual(p1.next_cursor, null);
  const p2 = browseRows(db, { from: "2026-10-01", to: "2026-10-31", late: "true", limit: "2", cursor: p1.next_cursor });
  assert.deepEqual(p2.data.map((r) => r.id), [105]);
  assert.equal(p2.next_cursor, null);
});

test("browse: invalid params and non-issued cursors raise BadInput (400)", () => {
  const db = seed();
  const expect400 = (q) => assert.throws(() => browseRows(db, q), BadInputError);
  expect400({});
  expect400({ from: "2026-10-31", to: "2026-10-01" });
  expect400({ from: "2026-13-01", to: "2026-10-31" });
  expect400({ from: "2026-02-30", to: "2026-10-31" });
  expect400({ from: "2026-10-01", to: "2026-10-31", limit: "0" });
  expect400({ from: "2026-10-01", to: "2026-10-31", limit: "201" });
  expect400({ from: "2026-10-01", to: "2026-10-31", limit: "abc" });
  expect400({ from: "2026-10-01", to: "2026-10-31", sort: "priority" });
  expect400({ from: "2026-10-01", to: "2026-10-31", late: "maybe" });
  expect400({ from: "2026-10-01", to: "2026-10-31", site_id: "01x" });
  expect400({ from: "2026-10-01", to: "2026-10-31", cursor: "not-base64!" });
  expect400({ from: "2026-10-01", to: "2026-10-31", cursor: "eyJhIjoxfQ" }); // {"a":1}, not our shape
  // a cursor for a different sort must fail too
  const p1 = browseRows(db, { from: "2026-10-01", to: "2026-10-31", sort: "id", limit: "2" });
  expect400({ from: "2026-10-01", to: "2026-10-31", sort: "-id", cursor: p1.next_cursor });
});

// A cursor carrying a null metric key is legal (null-metric page boundary).
test("browse: null-metric cursor is accepted and continues the null group", () => {
  const db = seed();
  // Construct the exact boundary found on the live data: last page of the
  // non-null group, then the null group follows in id order.
  const p1 = browseRows(db, { from: "2026-10-01", to: "2026-10-31", sort: "response_business_minutes", limit: "200" });
  const cursorWithNull = Buffer.from(JSON.stringify({ s: "response_business_minutes", k: [null, 100] }), "utf8").toString("base64url");
  const page = browseRows(db, { from: "2026-10-01", to: "2026-10-31", sort: "response_business_minutes", limit: "200", cursor: cursorWithNull });
  assert.deepEqual(page.data.map((r) => r.id), [104]); // the only null row, id 100 <= 100 excluded
});

test("browse: metric walk keeps every null row after the last non-null one", () => {
  const db = seed();
  // Real-data trap found on 2026-10-31: a nulls-last row whose id is SMALLER
  // than the ids in the previous metric group must still be visited first in
  // the null group (ids ascend) — never skipped by a bad keyset predicate.
  db.prepare("UPDATE report_rows SET response_business_minutes = NULL, within_target = NULL WHERE request_id = 104").run();
  // 104 already has the smallest-but-one id: make its id(sort key) position
  // extreme by ALSO adding a high-metric row to pass over it.
  db.prepare(
    "UPDATE report_rows SET response_business_minutes = 9999 WHERE request_id = 105",
  ).run();
  const seen = [];
  let cursor;
  for (;;) {
    const page = browseRows(db, cursor ? { ...{ from: "2026-10-01", to: "2026-10-31" }, sort: "response_business_minutes", limit: "2", cursor } : { from: "2026-10-01", to: "2026-10-31", sort: "response_business_minutes", limit: "2" });
    seen.push(...page.data.map((r) => [r.response_business_minutes, r.id]));
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(seen, [
    [10, 101],
    [60, 102],
    [240, 103],
    [9999, 105],
    [null, 104], // must appear AFTER the non-null group despite id 104 < 105
  ]);
});

test("churn mid-walk: canceled insert produces no row; stable rows still exactly once", () => {
  const db = seed();
  const seen = [];
  let cursor;
  const q = { from: "2026-10-01", to: "2026-10-31", limit: "2" };
  for (;;) {
    if (cursor) q.cursor = cursor;
    const page = browseRows(db, q);
    seen.push(...page.data.map((r) => r.id));
    if (seen.length === 2) {
      // A canceled request arrives mid-walk: it must never appear (rule 1).
      db.prepare(
        `INSERT INTO requests (id, ref, title, site_id, status, priority, created_at, updated_at, due_on,
           assignee_id, deleted_at, merged_into_id) VALUES (300, '', '', 11, 'canceled', 'High', ?, NULL, NULL, NULL, NULL, NULL)`,
      ).run(Date.parse("2026-10-07T02:00:00Z") / 1000);
      materializeRows(db, new Set([300]));
    }
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
  }
  assert.deepEqual(seen, [101, 102, 103, 104, 105]);
});
