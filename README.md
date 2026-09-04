# Moneycontrol earnings scraper

Scrapes [moneycontrol.com/markets/earnings](https://www.moneycontrol.com/markets/earnings/),
resolves every company to its NSE symbol, dumps each symbol from the
[screener MCP server](https://github.com/Tengenisu/screener-mcp-server), and
regenerates one JSON document per run — on a cron.

Two sections are captured:

| Section | Meaning |
|---|---|
| **RESULT CALENDAR** | companies *about to* release quarterly results (`Dhoot Transmiss · 1,615.50` rows) |
| **RAPID RESULTS** | companies that have *just posted* results, with Revenue / Gross Profit / Net Profit vs. the year-ago quarter |

Every company is resolved to its **NSE symbol** (`DTL03` → `DHOOTTRANS`). Stocks
listed only on the BSE come back with `nseSymbol: null` and are excluded from the
`nseSymbols` list. Each remaining symbol is then dumped in full — 19 MCP tool
calls apiece.

TypeScript on Node ≥ 20, laid out like `screener-mcp-server`: `src/constants.ts`
for tunables, `src/services/` for the I/O, `src/tools/` for the MCP job
catalogue, `src/index.ts` for the entrypoint. The page is a Next.js app and both
sections are server-rendered into the `__NEXT_DATA__` blob, which is what the
scraper reads — no headless browser.

> Previously Python (`scraper.py` + `md_to_json.py` + `mcp_query.js`). The
> rewrite drops the per-symbol `node` subprocess — the MCP calls are made
> directly over JSON-RPC — which took a warm full pass from ~3 minutes to under
> 20 seconds, and it means nothing in the n8n container needs `python3` any
> more, which the Alpine image doesn't ship.

## ⚠ Testing mode

The repo is currently configured for **testing**, not production:

* **Nothing is cached.** `CACHE_ENABLED=0`, no symbol cache, the earnings page is
  fetched with a cache-busting query param and every MCP call sends
  `Cache-Control: no-cache`. Every run regenerates every field from scratch.
* **The cadence is 5 minutes** (`CRON_SCHEDULE="*/5 * * * *"`), around the clock.

To go back to production: set `CACHE_ENABLED=1` and use the half-hourly line
commented at the bottom of `crontab.txt`.

A full pass over ~8 symbols takes about 20 seconds when the MCP server's own
cache is warm and 1.5–2.5 minutes cold. It can never run longer than
`RUN_DEADLINE_MS` (4 minutes): when that is hit, the symbols still queued come
back as `pending`, the snapshot is marked `"truncated": true`, and the next tick
picks them up — a partial answer on time beats a run that never ends. Each MCP
call is separately capped at `MCP_TIMEOUT_MS` (30s).

Ticks are serialised too: `runOnce` takes a lock file (`.scraper.lock`), and an
overlapping tick exits immediately with

```json
{"ok": true, "skipped": true, "reason": "run already in progress"}
```

A lock older than `LOCK_STALE_MS` (default 900000) is treated as a crashed run
and stolen. `--no-lock` bypasses the whole mechanism.

## Setup

```bash
npm install
npm run build
```

The screener MCP server must be reachable at `MCP_ENDPOINT`
(default `http://127.0.0.1:3123/mcp`) — start it from its own checkout with:

```bash
TRANSPORT=http PORT=3123 npm start
```

## Usage

```bash
npm run cron                       # the 5-minute schedule, in-process (Windows-friendly)
npm run once                       # one pass, JSON on stdout
npm run symbols                    # just the resolved NSE symbols, one per line

node dist/index.js                 # same as `npm run once`
node dist/index.js --pretty        # indented
node dist/index.js --section rapid # RAPID RESULTS only
node dist/index.js --section calendar
node dist/index.js --no-mcp        # skip the MCP step (scrape only)
node dist/index.js --out data.json # also write the document to a file
node dist/index.js --quiet         # write data/ but print nothing
node dist/index.js --cron --print  # print every snapshot in cron mode (quiet by default)
node dist/index.js --no-lock       # run even if another pass is in flight
node dist/index.js --help
```

Failures are reported as `{"ok": false, "error": "..."}` on stdout with exit
code 1, so the n8n Execute Command node always has parseable output. Logs go to
stderr.

## Layout

| Path | Purpose |
|---|---|
| `src/index.ts` | CLI: argument parsing, one-shot vs. cron mode, stdout contract |
| `src/pipeline.ts` | one full pass: lock → scrape → resolve → dump → assemble → write |
| `src/constants.ts` | every tunable; each overridable by an env var of the same name |
| `src/types.ts` | the shape of a snapshot, a dump, a parsed Markdown document |
| `src/schemas/index.ts` | zod schemas for the CLI, the price feed and the JSON-RPC envelope |
| `src/services/http.ts` | GET with retries, throttling, browser headers, optional cache |
| `src/services/moneycontrol.ts` | `__NEXT_DATA__` extraction and both section parsers |
| `src/services/symbols.ts` | scId → NSE symbol via Moneycontrol's price feed |
| `src/services/mcp.ts` | JSON-RPC client for the MCP server (JSON and SSE replies) |
| `src/services/markdown.ts` | Markdown → JSON for tool answers that aren't JSON |
| `src/services/store.ts` | writes `data/` and prunes old runs |
| `src/services/scheduler.ts` | the in-process cron, with overlap handling |
| `src/services/lock.ts` | the cross-process run lock |
| `src/services/{format,log}.ts` | number/text helpers; stderr logger |
| `src/tools/catalog.ts` | the 19 MCP calls fired per symbol |
| `src/tools/dump.ts` | runs the catalogue and classifies each answer |
| `crontab.txt` | the 5-minute schedule for a POSIX host |
| `run_every.ps1` | the same loop for a Windows host that wants PowerShell to own it |
| `n8n-workflows/moneycontrol-earnings-scraper.json` | the n8n workflow |

## The MCP step

`src/tools/catalog.ts` builds 19 JSON-RPC `tools/call` requests per symbol,
fired at `MCP_ENDPOINT` in a fixed order so two runs of the same symbol diff
cleanly:

search match · company overview · quarters · profit & loss · balance sheet ·
cash flow · ratios · peer comparison · NSE quote · NSE announcements ·
NSE corporate actions · RSI 14 / SMA 50 / EMA 200 / MACD, on both NSE and BSE.

`MCP_CONCURRENCY` symbols are dumped at a time (default 2). One `tools/list`
probe runs first, so a dead endpoint is reported once instead of as the same
connection error repeated 19 times per symbol.

```json
{"symbol": "TECHNOCRAF", "ok": true,
 "data": {
   "symbol": "TECHNOCRAF", "generatedAt": "2026-09-04T04:35:41.164Z",
   "counts": {"total": 19, "ok": 17, "failed": 2, "empty": 7},
   "jobs": [
     {"label": "QUARTERS", "tool": "screener_get_financial_statement",
      "ok": true, "error": null, "empty": false, "durationMs": 412,
      "content": {"sections": [...], "fields": {...},
                  "tables": [[{"Line item": "Sales", "Jun 2026": 93}]]},
      "data": {...},
      "raw": "## Quarterly Results\n| Line item | ..."},
     {"label": "NSE LIVE QUOTE", "tool": "nse_get_quote",
      "ok": false, "error": "Error: NSE returned HTTP 403. ..."}
   ]}}
```

Per job: `data` holds the tool's JSON (parsed text or `structuredContent`),
`content` holds the structured Markdown (`fields` merges `Key: value` lines,
`tables` become row objects with numeric cells coerced), and `raw` always keeps
the original text so nothing is lost if the shape changes. `ok: false` marks a
real tool error; `empty: true` marks a legitimate "no data" answer (no corporate
actions, not enough price history for a 200-day EMA) — the run is not failed by
either. A symbol whose every call fails comes back as
`{"symbol": ..., "ok": false, "error": "..."}` rather than aborting the run, and
one the deadline never reached comes back as
`{"symbol": ..., "ok": false, "pending": true, ...}` — not a failure, just work
deferred to the next tick.

## Output shape

```json
{
  "ok": true,
  "runId": "20260904T062119Z",
  "source": "https://www.moneycontrol.com/markets/earnings/",
  "cacheEnabled": false,
  "scrapedAt": "2026-09-04T11:51:35.749+05:30",
  "durationMs": 16090,
  "calendarDate": "2026-09-04",
  "calendarRange": {"from": "2026-09-04", "to": "2026-09-09"},
  "resultCalendar": [
    {"date": "4 Sep", "company": "Dhoot Transmission", "shortName": "Dhoot Transmiss",
     "scId": "DTL03", "exchange": "N", "resultType": "Q1 FY26-27", "ltp": 1615.4,
     "changePercent": 2.01, "time": "Time Not Available", "marketCap": 33042.69,
     "url": "...", "financialsUrl": "...", "nseSymbol": "DHOOTTRANS"}
  ],
  "rapidResults": [
    {"date": "September 02, 2026", "company": "Technocraft Ven", "scId": "TVL01",
     "exchange": "N", "ltp": 372.8, "changePercent": -0.11,
     "financialType": "Consolidated", "period": "Q1 FY26-27",
     "columns": ["Q1 FY26-27", "Jun 26", "Jun 25", "Growth"],
     "quarterData": [{"metric": "Revenue", "current": 93, "previous": 91, "growthPercent": 2}],
     "url": "...", "nseSymbol": "TECHNOCRAF"}
  ],
  "nseSymbols": ["DHOOTTRANS", "TECHNOCRAF"],
  "counts": {"resultCalendar": 1, "rapidResults": 9, "nseSymbols": 8,
             "mcpOk": 8, "mcpFailed": 0, "mcpPending": 0},
  "truncated": false,
  "mcp": [ ... ],
  "files": {"latest": "...", "run": "...", "history": "...", "symbols": ["..."]}
}
```

No dedup is done — every run emits the current full snapshot, and n8n decides
what is new.

## Generated data

Every tick rewrites `data/` (override with `DATA_DIR`, disable with
`WRITE_DATA_FILES=0`):

```
data/latest.json                  the newest snapshot — what n8n and dashboards read
data/runs/earnings-<runId>.json   one file per run, pruned to KEEP_RUNS (default 50)
data/symbols/<SYMBOL>.json        the newest MCP dump per symbol
data/history.jsonl                one summary line per run, appended forever
```

Writes go to a `.tmp` file and are renamed into place, so a reader never sees a
half-written document. `data/` is gitignored.

## Schedule

Two ways to run the 5-minute cadence — **pick one**, or every symbol gets
queried twice:

```bash
npm run cron    # in-process node-cron; works on Windows, where there is no crond
```

```cron
CACHE_ENABLED=0
*/5 * * * *  cd /opt/cron_scrapper && node dist/index.js --once --quiet >> /var/log/earnings/cron.log 2>&1
```

`crontab.txt` carries that line plus the production alternatives; install it with
`crontab crontab.txt`. On Windows, `npm run cron` is the recommended path;
`run_every.ps1` is there for a host that wants PowerShell (or Task Scheduler) to
own the loop instead.

`SIGINT`/`SIGTERM` (`SIGINT`/`SIGBREAK` on Windows) stop the scheduler and wait
for an in-flight pass to finish, so `data/` is never left half-written.

## Configuration

Every constant in `src/constants.ts` is overridable by an env var of the same
name. The ones worth knowing:

| Variable | Default | What it does |
|---|---|---|
| `MCP_ENDPOINT` | `http://127.0.0.1:3123/mcp` | where the screener MCP server lives |
| `CRON_SCHEDULE` | `*/5 * * * *` | the in-process cadence |
| `CRON_TIMEZONE` | `Asia/Kolkata` | timezone the schedule is evaluated in |
| `RUN_ON_START` | `1` | fire one pass immediately on startup |
| `CACHE_ENABLED` | `0` | HTTP response cache + on-disk symbol cache |
| `MCP_CONCURRENCY` | `2` | symbols dumped in parallel |
| `MCP_TIMEOUT_MS` | `30000` | per MCP call — short on purpose; 19 calls × N symbols |
| `RUN_DEADLINE_MS` | `240000` | ceiling on one pass; the rest come back `pending` (0 = no ceiling) |
| `DATA_DIR` | `./data` | where snapshots are written |
| `KEEP_RUNS` | `50` | snapshots kept under `data/runs/` (0 = keep all) |
| `WRITE_DATA_FILES` | `1` | set to `0` for stdout-only runs |
| `LOCK_STALE_MS` | `900000` | age at which a lock is assumed to be a crashed run |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## n8n

`n8n-workflows/moneycontrol-earnings-scraper.json` — import it into n8n. It is
built like `screener-mcp-server`'s supervisor workflow: check the repo out
inside the container, install, build, then run the CLI.

```
Manual Trigger ─┐
Every 5 minutes ─┼→ Clone + Install + Build → Run Scraper → Parse Scraper JSON → Fresh Data? ─┬→ Split Into Companies
Called By Supervisor ─┘                                                                        └→ Skipped Or Failed
```

* **Clone + Install + Build** — `git fetch --depth 1 origin main` +
  `reset --hard origin/main` into `/home/node/.n8n/cron_scrapper` (tarball
  fallback when the image has no `git`), `npm ci --include=dev`, then
  `./node_modules/.bin/tsc -p tsconfig.json`. The n8n image sets
  `NODE_ENV=production`, which would skip devDependencies and leave `typescript`
  missing, so `NODE_ENV=development` is forced for the install. It prints
  `SYNC_OK <sha>` so you can see which commit is actually running.

  > It is deliberately **not** `git pull --ff-only`: on a shallow clone with no
  > upstream tracking that dies with `fatal: Cannot fast-forward to multiple
  > branches`, and behind a trailing `|| true` the failure is silent — the
  > container then runs a stale checkout indefinitely while still reporting
  > `BUILD_OK`.

* **Run Scraper** — `node dist/index.js --once` with `CACHE_ENABLED=0`,
  `MCP_ENDPOINT=http://127.0.0.1:3123/mcp` and `RUN_DEADLINE_MS=240000`, wrapped
  in `timeout -k 10 330`. Between the scraper's own deadline and that hard kill,
  this node cannot run into the next tick. It never exits non-zero and always
  prints exactly one document, so the next node always has something to parse.
  The tail of the log goes to stderr — that is where you look when a pass is
  slow.
* **Parse Scraper JSON** — turns the command's `stdout` into JSON and keeps the
  tail of `stderr` under `log`. Missing output, a failed build or unparseable
  text all become `{"ok": false, "error": "..."}` rather than an empty item.
* **Fresh Data?** routes real snapshots to **Split Into Companies** (one item per
  company, each carrying its own MCP dump under `mcp` and an `mcpStatus` of
  `done` / `pending` / `failed` / `no-nse-symbol`) and everything else — skipped
  ticks, build failures, scrape errors, the hard timeout — to **Skipped Or
  Failed**.

Nothing needs `python3` any more: the n8n image ships Node, which is all this
build step and the scraper need.

### When a pass takes too long

The **Run Scraper** node's stderr is the log. Each symbol logs its own line
(`MCP dump CRSL done in 3.4s (ok 17, failed 2, empty 6)`), so a slow pass points
straight at whichever call is dragging — usually the MCP server itself being
cold, rate-limited by screener.in, or blocked by NSE from inside the container.
If you see `run deadline reached — N symbol(s) left partial or undumped`, either
the endpoint is unhealthy or `RUN_DEADLINE_MS` needs raising along with the
cadence.

### This repo is private — the build step needs a token

`Tengenisu/cron_scrapper` is private (anonymous requests to both the API and
codeload get a 404), so a bare `git clone` inside the container fails with

```
fatal: could not read Username for 'https://github.com': No such device or address
```

That is GitHub refusing an anonymous client. **Clone + Install + Build** sets
`GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=/bin/true` so it fails fast with a
readable message instead of hanging on a prompt, and reads an optional
`GITHUB_TOKEN`:

```yaml
# docker-compose.yml
services:
  n8n:
    environment:
      - GITHUB_TOKEN=ghp_...   # PAT with read access to this repo
```

The token is passed per command via `http.extraHeader`, so it never lands in
`.git/config` on the n8n volume, and it is used for the tarball fallback too.
The node prints `auth: using GITHUB_TOKEN` or `auth: none (repo must be public)`
so you can see which path it took.

Alternatives: make the repo public, or bind-mount the code at
`/home/node/.n8n/cron_scrapper` and let the build step's `git pull` fail
harmlessly.

### Supervisor integration

`screener-mcp-server/n8n-workflows/screener-mcp-supervisor.json` has a
**Run Earnings Scraper** node hanging off **Report Healthy**, so this workflow is
kicked only once the MCP server has answered `tools/list` successfully — it can
never query a dead endpoint. `waitForSubWorkflow` is off so a pass never blocks
the supervisor's health loop.

After importing both workflows, open that node and set **Workflow** to the
imported scraper workflow (its `workflowId` currently reads
`REPLACE_WITH_MONEYCONTROL_SCRAPER_WORKFLOW_ID`).

## Notes on the data source

* The site is behind Akamai — requests need a browser `User-Agent`, which
  `USER_AGENT` supplies. `HTTP_RETRIES`/`HTTP_BACKOFF_MS` handle transient 503s.
* NSE symbols come from `priceapi.moneycontrol.com/pricefeed/{nse|bse}/equitycash/{scId}`
  (`NSEID` field). The `scId` from the page is authoritative — the trailing token
  in the stock URL is a *different* id and resolves to the wrong company.
* `nse_get_quote` returning HTTP 403 is NSE's anti-bot protection and is common;
  the announcements and corporate-actions tools usually still work in the same
  pass.
* If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the
  page or is blocking the request. That is the one failure mode worth alerting
  on.
