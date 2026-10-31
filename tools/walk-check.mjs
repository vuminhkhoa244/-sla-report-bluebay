// Property walk: every sort must yield every report row exactly once.
// Usage: node tools/walk-check.mjs [appUrl]   (default http://localhost:8080)
const APP = (process.argv[2] ?? process.env.APP_URL ?? "http://localhost:8080").replace(/\/$/, "");

const walk = async (sort) => {
  const seen = new Map();
  let cur;
  let pages = 0;
  for (;;) {
    const url = new URL(`${APP}/api/requests`);
    url.searchParams.set("from", "2026-05-01");
    url.searchParams.set("to", "2026-10-31");
    url.searchParams.set("limit", "200");
    url.searchParams.set("sort", sort);
    if (cur) url.searchParams.set("cursor", cur);
    const res = await fetch(url);
    const j = await res.json();
    if (!res.ok) {
      console.error(`HTTP ${res.status} on page ${pages} sort=${sort} cursor=${cur}`);
      throw new Error(JSON.stringify(j));
    }
    for (const row of j.data) seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
    pages++;
    if (j.next_cursor === null) {
      return { pages, rows: seen.size, dupes: [...seen.values()].filter((v) => v > 1).length };
    }
    cur = j.next_cursor;
  }
};

const rep = await (await fetch(`${APP}/api/sla-report?from=2026-05-01&to=2026-10-31`)).json();
console.log("report rows:", rep.requests.length);
for (const s of ["id", "-id", "response_business_minutes", "-response_business_minutes"]) {
  console.log(s, JSON.stringify(await walk(s)));
}
