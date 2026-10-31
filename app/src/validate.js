// Shared query parameter validation. Every validator returns a parsed value or
// throws BadInput, which the route translates to 400 per docs/contract.md.
export class BadInput extends Error {}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

// Validates real YYYY-MM-DD calendar dates, from <= to.
export function parseRange(query) {
  const from = query.from;
  const to = query.to;
  if (typeof from !== "string" || typeof to !== "string") {
    throw new BadInput("missing or invalid from/to (need YYYY-MM-DD, from <= to)");
  }
  if (!dateRe.test(from) || !dateRe.test(to)) {
    throw new BadInput("invalid from/to (need YYYY-MM-DD, from <= to)");
  }
  // String comparison alone would accept 2026-02-31; build the date back.
  const parse = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
  };
  const fromD = parse(from);
  const toD = parse(to);
  if (!fromD || !toD) throw new BadInput("invalid from/to (not a real calendar date)");
  if (fromD > toD) throw new BadInput("from is after to");
  return { from, to };
}

export function parseLimit(query, def = 50, max = 200) {
  const raw = query.limit;
  if (raw === undefined) return def;
  if (!/^\d+$/.test(String(raw))) throw new BadInput("invalid limit");
  const n = Number(raw);
  if (n < 1 || n > max) throw new BadInput("invalid limit (1-200)");
  return n;
}

export function parseIdFilter(query, name) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(String(raw))) throw new BadInput(`invalid ${name}`);
  return Number(raw);
}

export function parseBoolFilter(query, name) {
  const raw = query[name];
  if (raw === undefined) return undefined;
  const s = String(raw).toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  throw new BadInput(`invalid ${name}`);
}

export const SORTS = ["id", "-id", "response_business_minutes", "-response_business_minutes"];

export function parseSort(query) {
  const raw = query.sort;
  if (raw === undefined || raw === "") return "id";
  if (!SORTS.includes(String(raw))) throw new BadInput("invalid sort");
  return String(raw);
}

export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
  } catch {
    throw new BadInput("invalid cursor");
  }
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.k)) {
    throw new BadInput("invalid cursor");
  }
  return payload;
}
