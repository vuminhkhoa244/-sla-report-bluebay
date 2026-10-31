import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { state } from "../src/state.js";
import { runSync } from "../src/sync.js";

// Fake helpdesk: one empty config + one caught-up changes page. Exercises the
// real boot path (refreshConfig -> backfill -> materializeAll -> ready -> tail)
// which the earlier milestones only covered indirectly.
function fakeClient() {
  return {
    async get(path) {
      if (path === "/v1/sites") return { data: [] };
      if (path === "/v1/staff") return { data: [] };
      if (path === "/v1/changes") return { data: [], next_cursor: "fake-cursor", has_more: false };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

test("runSync boot path reaches ready even with a resumed empty backfill", async () => {
  const db = openDb(":memory:");
  const wasReady = state.ready;
  state.ready = false;
  const errors = [];
  const control = await runSync(fakeClient(), db, state, { error: (e) => errors.push(e), warn: () => {}, log: () => {} });
  try {
    assert.equal(state.ready, true);
  } finally {
    control.stop();
    state.ready = wasReady;
  }
  // One seeded request through applyChanges must flow: row materialized.
  const { applyChanges } = await import("../src/sync.js");
  applyChanges(db, [
    { type: "request.created", request: { id: 1, site_id: 11, status: "processing", priority: "High", created_at: "2026-10-05T02:00:00Z" } },
    { type: "event.created", request_id: 1, event: { id: 1, status: "processing", at: Date.parse("2026-10-05T02:05:00Z") / 1000, actor_id: 9 } },
  ]);
  const row = db.prepare("SELECT * FROM report_rows WHERE request_id = 1").get();
  assert.notEqual(row, undefined);
  assert.equal(row.responder_id, 9);
  assert.deepEqual(errors, []);
});
