import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { parseRange, BadInput } from "../src/validate.js";

function get(server, pathname) {
  const path = new URL(pathname, `http://127.0.0.1:${server.address().port}`);
  return fetch(path);
}

test("GET /health returns ok", async () => {
  const server = createApp(null).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const res = await get(server, "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test("GET /ready is 503 until the sync says otherwise", async () => {
  const { state } = await import("../src/state.js");
  const wasReady = state.ready;
  state.ready = false;
  const server = createApp(null).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const before = await get(server, "/ready");
    assert.equal(before.status, 503);
    state.ready = true;
    const after = await get(server, "/ready");
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { ready: true });
  } finally {
    state.ready = wasReady;
    server.close();
  }
});

test("parseRange rejects malformed ranges", () => {
  assert.deepEqual(parseRange({ from: "2026-10-01", to: "2026-10-31" }), { from: "2026-10-01", to: "2026-10-31" });
  assert.throws(() => parseRange({}), BadInput);
  assert.throws(() => parseRange({ from: "01/10/2026", to: "2026-10-31" }), BadInput);
  assert.throws(() => parseRange({ from: "2026-02-31", to: "2026-10-31" }), BadInput); // fake date
  assert.throws(() => parseRange({ from: "2026-10-31", to: "2026-10-01" }), BadInput); // reversed
});
