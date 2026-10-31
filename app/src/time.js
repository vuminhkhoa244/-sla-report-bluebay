// Timezone machinery, built on Intl (IANA-native, zero dependencies).
//
// Two primitives matter:
//  1. zonedParts(sec, tz): which wall-clock date/time an epoch instant is in.
//  2. zonedToEpochSec(date, "HH:MM", tz): the inverse. The classic two-pass
//     algorithm: assume UTC, ask Intl what the wall clock reads there, fix up
//     with the offset. Correct across DST; ambiguous fall-back hours resolve to
//     the first occurrence (documented in DECISIONS.md).
const partsCache = new Map(); // tz -> Intl.DateTimeFormat
const offsetCache = new Map(); // `${tz}@${hourBucket}` -> seconds; memoized per hour to keep DST edges cheap

function fmt(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  return f;
}

// {y, mo, d, h, mi, s} integers for an epoch instant in a zone.
export function zonedParts(epochSec, tz) {
  const parts = fmt(tz).formatToParts(new Date(epochSec * 1000));
  let out = {};
  for (const p of parts) out[p.type] = p.value;
  return {
    y: Number(out.year),
    mo: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour),
    mi: Number(out.minute),
    s: Number(out.second),
  };
}

export function pad2(n) {
  return String(n).padStart(2, "0");
}

export function localDateStr(p) {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
}

// Local wall clock reads y/m/d h:mi:s; the epoch instant that has that wall
// clock in tz (offset as seconds to subtract from wall-clock UTC reckoning).
export function tzOffsetSec(epochSec, tz) {
  const bucket = Math.floor(epochSec / 3600); // cheap memo; fine except on DST edges
  const key = `${tz}@${bucket}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = zonedParts(epochSec, tz);
    const wallAsUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) / 1000;
    off = wallAsUtc - epochSec;
    offsetCache.set(key, off);
    if (offsetCache.size > 4096) offsetCache.clear(); // pathological only
  }
  return off;
}

export function zonedToEpochSec(dateStr, timeStr, tz) {
  const memoKey = `${tz}|${dateStr}|${timeStr}`;
  let memoed = zonedToEpochSec.cache.get(memoKey);
  if (memoed !== undefined) return memoed;

  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi, s] = String(timeStr).split(":").map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi || 0, s || 0) / 1000;
  // Pass 1: guess the offset at the naive instant; pass 2: redo at the
  // corrected instant so a DST boundary in the target zone still resolves.
  const off1 = tzOffsetSec(wallAsUtc - 0, tz);
  let epoch = wallAsUtc - off1;
  // recompute offset at the candidate instant
  const off2 = tzOffsetSec(epoch, tz);
  if (off2 !== off1) epoch = wallAsUtc - off2;
  if (zonedToEpochSec.cache.size > 50_000) zonedToEpochSec.cache.clear();
  zonedToEpochSec.cache.set(memoKey, epoch);
  return epoch;
}
zonedToEpochSec.cache = new Map();

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function dayKey(dateStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
}

export function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// Business-hours seconds between two instants (rule 4): walk each site-local
// day in [start, end], take the overlap with that day's open window, skip
// holidays and closed days. Raw seconds are summed; the caller floors once at
// the end (flooring per day would count a 45s/45s split across two days as 0).
export function businessSecondsBetween(tz, hours, holidays, startSec, endSec) {
  if (startSec === null || endSec === null || endSec < startSec) return 0;
  let total = 0;
  let cursor = startSec;
  for (;;) {
    if (cursor > endSec) break;
    const p = zonedParts(cursor, tz);
    const date = localDateStr(p);
    if (!holidays.has(date)) {
      const win = hours && hours[dayKey(date)];
      if (win && win.open && win.close) {
        const open = zonedToEpochSec(date, win.open, tz);
        const close = zonedToEpochSec(date, win.close, tz);
        const from = Math.max(open, cursor);
        const to = Math.min(close, endSec);
        if (to > from) total += to - from;
      }
    }
    const midnight = zonedToEpochSec(addDays(date, 1), "00:00", tz);
    if (midnight <= cursor) {
      // A zone messing with midnight (rare but legal); advance an hour so we
      // can never spin forever.
      cursor = cursor + 3600;
    } else {
      cursor = midnight;
    }
  }
  return total;
}
