import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { applyChanges, toSec, refreshConfig } from "../src/sync.js";

const memoryDb = () => openDb(":memory:");

test("applyChanges upserts requests and events idempotently", () => {
  const db = memoryDb();
  const changes = [
    {
      type: "request.created",
      request: {
        id: 41210,
        ref: "WO-41210",
        title: "Room too warm",
        site_id: 11,
        status: "processing",
        priority: "High",
        created_at: "2026-10-06T02:15:07Z",
        updated_at: "2026-10-06T03:40:00Z",
        due_on: "2026-10-07",
        assignee: { id: 304, name: "Benjamin Tan" },
        deleted_at: null,
        merged_into_id: null,
      },
    },
    {
      type: "request.created",
      // The docs say items may arrive more than once — they arrive with the
      // same full payload, so the row must not duplicate.
      request: {
        id: 41210,
        ref: "WO-41210",
        title: "Room too warm",
        site_id: 11,
        status: "processing",
        priority: "High",
        created_at: "2026-10-06T02:15:07Z",
        updated_at: "2026-10-06T03:40:00Z",
        due_on: "2026-10-07",
        assignee: { id: 304, name: "Benjamin Tan" },
        deleted_at: null,
        merged_into_id: null,
      },
    },
    {
      type: "event.created",
      request_id: 41210,
      event: {
        id: 300912,
        status: "processing",
        at: 1791874530,
        actor_id: 304,
        actor_name: "Benjamin Tan",
        due_at: "07/10/2026 10:00",
        reverts_id: null,
      },
    },
  ];

  applyChanges(db, changes);
  applyChanges(db, changes); // duplicates are harmless by design

  const req = db.prepare("SELECT * FROM requests WHERE id = 41210").get();
  assert.equal(req.id, 41210);
  assert.equal(req.status, "processing");
  assert.equal(req.created_at, Date.parse("2026-10-06T02:15:07Z") / 1000);
  assert.equal(req.assignee_id, 304);

  const evts = db.prepare("SELECT id FROM events WHERE request_id = 41210").all();
  assert.equal(evts.length, 1);

  const cur = db.prepare("SELECT value FROM sync_state WHERE key = 'cursor'").get();
  assert.equal(cur, undefined);
});

test("toSec normalizes ISO and unix-seconds inputs", () => {
  assert.equal(toSec("2026-10-06T02:15:07Z"), Date.parse("2026-10-06T02:15:07Z") / 1000);
  assert.equal(toSec(1791874530), 1791874530);
  // Missing Z is treated as UTC, not the server's local timezone.
  assert.equal(toSec("2026-10-06T02:15:07"), Date.parse("2026-10-06T02:15:07Z") / 1000);
  assert.equal(toSec(null), null);
  assert.equal(toSec(""), null);
});

test("refreshConfig loads sites, holidays and staff", async () => {
  const db = memoryDb();
  const fake = {
    async get(path) {
      if (path === "/v1/sites") {
        return {
          data: [
            {
              id: 11,
              name: "Bluebay Tower Singapore",
              timezone: "Asia/Singapore",
              business_hours: { mon: { open: "08:00", close: "18:00" }, sun: null },
            },
          ],
        };
      }
      if (path === "/v1/sites/11/holidays") return { data: [{ date: "10/08/2026", name: "National Day (observed)" }] };
      if (path === "/v1/staff") return { data: [{ id: 304, name: "Benjamin Tan" }] };
      throw new Error(`unexpected path ${path}`);
    },
  };
  const count = await refreshConfig(fake, db);
  assert.equal(count, 1);
  const site = db.prepare("SELECT * FROM sites WHERE id = 11").get();
  assert.equal(site.timezone, "Asia/Singapore");
  assert.deepEqual(JSON.parse(site.business_hours).mon, { open: "08:00", close: "18:00" });
  const holiday = db.prepare("SELECT * FROM holidays WHERE site_id = 11").get();
  assert.equal(holiday.date, "10/08/2026");
  const staff = db.prepare("SELECT * FROM staff WHERE id = 304").get();
  assert.equal(staff.name, "Benjamin Tan");
});
