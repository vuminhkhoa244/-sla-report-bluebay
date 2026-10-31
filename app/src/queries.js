// Level 4: /api/requests — the report rows, filterable, sortable, and paged
// with keyset cursors over the materialized report_rows table.
//
// Keyset is what honors the contract's exactly-once property: the cursor stores
// the sort key + id of the last row, so a page boundary is a stable property of
// the row itself and re-reads can never duplicate a row that keeps matching.
//
// /api/requests.csv (client request from the finance team) shares this exact
// filter/sort core, minus limit/cursor: it always streams every matching row.
import {
  parseRange,
  parseLimit,
  parseIdFilter,
  parseBoolFilter,
  parseSort,
  encodeCursor,
  decodeCursor,
  BadInput,
} from "./validate.js";

const SORT_SPEC = {
  id: { col: "rr.request_id", dir: "ASC" },
  "-id": { col: "rr.request_id", dir: "DESC" },
  response_business_minutes: { col: "rr.response_business_minutes", dir: "ASC" },
  "-response_business_minutes": { col: "rr.response_business_minutes", dir: "DESC" },
};

const boolOf = (v) => (v === null || v === undefined ? null : v === 1 || v === true);

const SELECT_COLUMNS = `rr.request_id AS id, rr.site_id, rr.responder_id,
  rr.response_business_minutes, rr.within_target, rr.completed_late, st.name AS responder`;

const toRow = (r) => ({
  id: r.id,
  site_id: r.site_id,
  responder_id: r.responder_id,
  responder: r.responder ?? null, // current name joined from staff (rule 3)
  response_business_minutes: r.response_business_minutes,
  within_target: boolOf(r.within_target),
  completed_late: boolOf(r.completed_late),
});

// Shared validation + WHERE/ORDER BY construction for both endpoints.
function buildBrowse(db, query, { withCursor = true, withLimit = true } = {}) {
  const { from, to } = parseRange(query);
  const siteId = parseIdFilter(query, "site_id");
  const responderId = parseIdFilter(query, "responder_id");
  const late = parseBoolFilter(query, "late");
  const withinTarget = parseBoolFilter(query, "within_target");
  const sort = parseSort(query);

  const wheres = [`rr.local_date >= ?`, `rr.local_date <= ?`];
  const params = [from, to];
  if (siteId !== undefined) {
    wheres.push(`rr.site_id = ?`);
    params.push(siteId);
  }
  if (responderId !== undefined) {
    wheres.push(`rr.responder_id = ?`);
    params.push(responderId);
  }
  if (late !== undefined) {
    wheres.push(`rr.completed_late = ?`);
    params.push(late ? 1 : 0);
  }
  if (withinTarget !== undefined) {
    wheres.push(`rr.within_target = ?`);
    params.push(withinTarget ? 1 : 0);
  }

  const spec = SORT_SPEC[sort];
  let orderBy;
  if (sort === "id" || sort === "-id") {
    orderBy = `rr.request_id ${spec.dir}`;
  } else {
    // Nulls last: order by the IS NULL flag first. Within equal sort keys,
    // ties by id ascending (docs), for both directions.
    orderBy = `(rr.response_business_minutes IS NULL) ASC, rr.response_business_minutes ${spec.dir}, rr.request_id ASC`;
  }

  let cursorPayload = null;
  if (withCursor && query.cursor !== undefined && query.cursor !== "") {
    cursorPayload = decodeCursor(query.cursor);
    if (cursorPayload.s !== sort) throw new BadInput("cursor does not match sort order");
    const key = cursorPayload.k;
    const okShape =
      (sort === "id" || sort === "-id"
        ? key.length === 1 && typeof key[0] === "number" && Number.isFinite(key[0])
        : key.length === 2 &&
          ((key[0] === null && typeof key[1] === "number" && Number.isFinite(key[1])) ||
            (typeof key[0] === "number" && Number.isFinite(key[0]) && typeof key[1] === "number" && Number.isFinite(key[1]))));
    if (!okShape) throw new BadInput("invalid cursor");
    if (sort === "id" || sort === "-id") {
      const [id] = key;
      wheres.push(`rr.request_id ${spec.dir === "ASC" ? ">" : "<"} ?`);
      params.push(id);
    } else {
      const [rbmKey, idKey] = key;
      const op = spec.dir === "ASC" ? ">" : "<";
      // The nulls-last group is entirely after the non-null group in BOTH
      // directions, so from a non-null cursor every null row is still ahead
      // (no id filter); from a null cursor only the null group remains.
      if (rbmKey === null) {
        wheres.push(`rr.response_business_minutes IS NULL AND rr.request_id > ?`);
        params.push(idKey);
      } else {
        wheres.push(
          `((rr.response_business_minutes IS NOT NULL AND (rr.response_business_minutes ${op} ? OR (rr.response_business_minutes = ? AND rr.request_id > ?))) OR rr.response_business_minutes IS NULL)`,
        );
        params.push(rbmKey, rbmKey, idKey);
      }
    }
  }

  return {
    from,
    to,
    limit: withLimit ? parseLimit(query) : null,
    sort,
    wheres,
    params,
    orderBy,
  };
}

export function browseRows(db, query) {
  const { limit, wheres, params, orderBy, sort } = buildBrowse(db, query);

  // Fetch limit+1: an extra row only decides next_cursor, never goes out.
  const sql = `SELECT ${SELECT_COLUMNS}
       FROM report_rows rr LEFT JOIN staff st ON st.id = rr.responder_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const data = page.map(toRow);

  let nextCursor = null;
  if (hasMore) {
    const last = page[page.length - 1];
    const key =
      sort === "id" || sort === "-id"
        ? [last.id]
        : [last.response_business_minutes, last.id];
    nextCursor = encodeCursor({ s: sort, k: key });
  }
  return { data, next_cursor: nextCursor };
}

// -- /api/requests.csv -------------------------------------------------------
// Same parameters as /api/requests; limit and cursor are ignored (per the
// client's request): invalid limit/cursor values are simply not consulted.
// Every matching row, in `sort` order, with true/false booleans, empty fields
// for nulls, and standard RFC 4180 quoting.

function csvField(v) {
  if (v === null || v === undefined) return "";
  let s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildRequestsCsv(db, query) {
  const { wheres, params, orderBy } = buildBrowse(db, query, { withCursor: false, withLimit: false });
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM report_rows rr LEFT JOIN staff st ON st.id = rr.responder_id
       WHERE ${wheres.join(" AND ")}
       ORDER BY ${orderBy}`,
    )
    .all(...params)
    .map(toRow);
  const header = "id,site_id,responder_id,responder,response_business_minutes,within_target,completed_late";
  const lines = rows.map((r) =>
    [r.id, r.site_id, r.responder_id, r.responder, r.response_business_minutes, r.within_target, r.completed_late]
      .map(csvField)
      .join(","),
  );
  return `${header}\r\n${lines.join("\r\n")}\r\n`;
}

export { BadInput };
