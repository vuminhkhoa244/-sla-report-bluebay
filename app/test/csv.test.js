import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { materializeAll } from "../src/rules.js";
import { buildRequestsCsv, browseRows } from "../src/queries.js";
import { seed } from "./util.seed.js";

test("csv: exact header, boolean literal, empty nulls, standard quoting", () => {
  const db = seed();
  const csv = buildRequestsCsv(db, { from: "2026-10-01", to: "2026-10-31", sort: "response_business_minutes" });
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "id,site_id,responder_id,responder,response_business_minutes,within_target,completed_late");
  // sorted ascending by business minutes: 101 (10), 102 (60), 103 (240), null-group last in id order
  assert.deepEqual(
    lines.slice(1).filter((l) => l !== ""),
    [
      "101,11,304,Benjamin Tan,10,true,false",
      "102,11,304,Benjamin Tan,60,true,true",
      "103,12,305,Ana Wijaya,240,true,true",
      "105,11,304,Benjamin Tan,1140,false,true",
      "104,12,,,,,", // nulls: no responder, no minutes, no booleans (7 columns)
    ],
  );
  assert.equal(csv.endsWith("\r\n"), true);
});

test("csv: names containing commas or quotes are quoted (RFC 4180)", () => {
  const db = seed();
  db.prepare("UPDATE staff SET name = 'Tan, Ben \"The Fixer\"' WHERE id = 304").run();
  // names are joined at read time, so re-materialization is unnecessary
  const csv = buildRequestsCsv(db, { from: "2026-10-01", to: "2026-10-31", sort: "id" });
  const line101 = csv.split("\r\n").find((l) => l.startsWith("101,"));
  assert.equal(line101, '101,11,304,"Tan, Ben ""The Fixer""",10,true,false');
});

test("csv: same filters as /api/requests", () => {
  const db = seed();
  const csvLate = buildRequestsCsv(db, { from: "2026-10-01", to: "2026-10-31", late: "true", sort: "id" });
  const ids = csvLate.split("\r\n").slice(1).filter(Boolean).map((l) => Number(l.split(",")[0]));
  assert.deepEqual(ids, [102, 103, 105]);
  const jsonLate = browseRows(db, { from: "2026-10-01", to: "2026-10-31", late: "true", sort: "id", limit: "200" });
  assert.deepEqual(ids, jsonLate.data.map((r) => r.id));
});

test("csv: limit and cursor are ignored everywhere", () => {
  const db = seed();
  const full = buildRequestsCsv(db, { from: "2026-10-01", to: "2026-10-31", sort: "id" });
  const withGarbage = buildRequestsCsv(db, {
    from: "2026-10-01",
    to: "2026-10-31",
    sort: "id",
    limit: "1",          // a valid-but-small limit: ignored
    cursor: "!!notbase64", // an invalid cursor: ignored
  });
  assert.equal(withGarbage, full);
  assert.equal(withGarbage.split("\r\n").filter(Boolean).length, 6); // header + 5 rows
});
