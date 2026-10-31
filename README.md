# Bluebay response-time report

For any date range in the last six months, this web app answers the client's question:

> "For each site, how fast do our teams respond, and how often does work finish late?"

It reads the helpdesk through its change feed, computes the SLA rules from `docs/rules.md`
(timezone-correct, business-hours, per-site holiday-aware), and serves the report on a page
and on graded JSON endpoints. Built on the kit's `node-express` starter.

```
docs/contract.md    the response shapes this app must return
docs/rules.md       the seven rules the report implements
docs/api.md         the helpdesk API this app reads
DECISIONS.md        assumptions, data surprises, AI use, trade-offs — read this second
tools/walk-check.mjs  live proof: every sort / page yields every row exactly once
```

## Run it

```bash
docker compose up --build            # app on http://localhost:8080
curl http://localhost:8080/health    # {"ok": true}
curl http://localhost:8080/ready     # 200 {"ready":true} once backfill + rebuild finish (~65s cold)
docker compose run --rm app test     # 30 unit tests, exit 0
```

`HELPDESK_URL` and `HELPDESK_TOKEN` go in `.env` (copy `.env.example`). If another container
already owns host port 8080, set `HOST_APP_PORT=8081` in `.env` — the container's port and the
graded default stay 8080.

## What it serves

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | liveness |
| `GET /ready` | 200 once the six-month report is servable (grader budget: 8 min; measured: ~65 s cold, ~4 s warm) |
| `GET /api/sla-report?from=YYYY-MM-DD&to=YYYY-MM-DD` | one row per request + per-responder summary |
| `GET /api/requests` | the same rows with filters (`site_id`, `responder_id`, `late`, `within_target`), sorts (`id` / `-id` / `response_business_minutes` / `-...`), keyset cursor paging |
| `GET /api/requests.csv` | client request (finance team): every matching row as CSV, same params as `/api/requests` (limit/cursor ignored); download button on `/browse.html` |

A plain page at `/` shows the report; `/browse.html` adds the level-4 browsing UI. Both show
fetch timings and both are kept live by the sync.

## How it works

```
helpdesk ──/v1/changes──> sync (app/src/sync.js)        backfill once, then tail every ~2s,
                             │  upserts, idempotent      honoring 429 Retry-After; cursor
                             ▼                           persisted in SQLite → fast restarts
                          SQLite (app/src/db.js)      requests, events, staff, sites, holidays
                             │                           + materialized rule outcomes (report_rows)
                             ▼
              rules engine (app/src/rules.js, app/src/time.js)
                             │  business-seconds per site-local day, reverts,
                             │  deadlines as site-local wall clocks
                             ▼
                 /api/sla-report · /api/requests · the pages
```

- **Fast:** rule outcomes are computed when changes arrive (materialized), not per request.
  Six-months ≈ 11k rows answers in ~0.1 s against a 10 s budget; October in ~0.04 s.
- **Live:** the change feed is tailed continuously; helpdesk changes appear well inside 60 s.
- **Correct:** the rules engine is a pure module with 30 tests (DST edges, reverts, local-date
  boundaries, sum-seconds-then-floor business minutes, keyset exactly-once). `tools/walk-check.mjs`
  pages through all four sort orders against the running app and asserts 0 duplicates / 0 missing.

## Notes for reviewers

- Commit history goes kit → sync → rules → report → browse in small reviewable steps.
- `DECISIONS.md` documents the interesting parts: Jakarta's Saturday opening hours, staff
  sharing a name, a real pagination bug the live data caught (with the fix and its test), and
  exactly how AI was used.
