# Moneycontrol earnings scraper

Scans [moneycontrol.com/markets/earnings](https://www.moneycontrol.com/markets/earnings/)
for the stocks that have results, resolves each one to a symbol the
[screener MCP server](https://github.com/Tengenisu/screener-mcp-server) can look
up, dumps it, formats what comes back, and regenerates one JSON document per run
— on a cron.

**This repo contributes no data of its own.** Moneycontrol is used as the *scan*
and nothing else: which stocks, and what their symbol is. Its own numbers —
price, change, market cap, the revenue/profit table it prints next to each rapid
result — are never read and never emitted. Every figure in a snapshot came from
the MCP server, so there is exactly one answer to any question about a company
rather than two differently-sourced ones sitting side by side.

Two sections are scanned:

| Section | What it means | `events` |
|---|---|---|
| **RESULT CALENDAR** | companies *about to* release quarterly results | `upcoming` |
| **RAPID RESULTS** | companies that have *just posted* results | `reported` |

A company listed in both carries both events and is still dumped once.

Every company is resolved to a symbol via Moneycontrol's price feed: its **NSE
ticker** where it has one (`DTL03` → `DHOOTTRANS`), and otherwise its **BSE scrip
code** (`VIVAN54173` → `541735`). The code is a real identifier downstream —
screener.in serves `/company/541735/` and Yahoo, which the technical indicators
read, takes `541735.BO` — so a BSE-only stock is dumped like any other instead of
being dropped. Only a scrip the feed knows neither ID for comes back
`status: "unresolved"`.

TypeScript on Node ≥ 20, laid out like `screener-mcp-server`: `src/constants.ts`
for tunables, `src/services/` for the I/O, `src/tools/` for the MCP job
catalogue, `src/index.ts` for the entrypoint. The page is a Next.js app and both
sections are server-rendered into the `__NEXT_DATA__` blob, which is what the
scanner reads — no headless browser.

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

A full pass over ~10 stocks takes about 18 seconds when the MCP server's own
cache is warm and 1.5–2.5 minutes cold. It can never run longer than
`RUN_DEADLINE_MS` (4 minutes): when that is hit, the stocks still queued come
back with `status: "pending"`, the snapshot is marked `"truncated": true`, and
the next tick picks them up — a partial answer on time beats a run that never
ends. Each MCP
call is separately capped at `MCP_TIMEOUT_MS` (30s).

Ticks are serialised too: `runOnce` takes a lock file (`.scraper.lock`), and an
overlapping tick exits immediately with

```json
{"ok": true, "skipped": true, "reason": "run already in progress"}
```

The lock records the owning pid, so a run that was killed — a cancelled n8n
execution, `timeout` firing, the container stopping — does not block anything:
the next tick sees a dead pid and steals the file on the spot. It is also
removed on `exit`/`SIGINT`/`SIGTERM`, and stolen outright once older than
`LOCK_STALE_MS` (the run deadline plus 90s) for the one case a pid check can't
see. `--no-lock` bypasses the whole mechanism.

> If every tick returns `{"ok": true, "skipped": true}` and nothing ever runs,
> that is an orphaned lock — versions before this behaviour blocked for a full
> 15 minutes after any killed run. Deleting `.scraper.lock` clears it by hand.

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
npm run symbols                    # just the resolved symbols, "SYMBOL<TAB>NSE" per line

node dist/index.js                 # same as `npm run once`
node dist/index.js --pretty        # indented
node dist/index.js --section rapid # RAPID RESULTS only
node dist/index.js --section calendar
node dist/index.js --no-mcp        # skip the MCP step (scan + resolve only)
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
| `src/pipeline.ts` | one full pass: lock → scan → resolve → dump → format → write |
| `src/constants.ts` | every tunable; each overridable by an env var of the same name |
| `src/types.ts` | the shape of a snapshot, a dump, a formatted document |
| `src/schemas/index.ts` | zod schemas for the CLI, the price feed and the JSON-RPC envelope |
| `src/services/http.ts` | GET with retries, throttling, browser headers, optional cache |
| `src/services/moneycontrol.ts` | `__NEXT_DATA__` extraction; the scan, company identity only |
| `src/services/symbols.ts` | scId → NSE ticker, else BSE code, via Moneycontrol's price feed |
| `src/services/mcp.ts` | JSON-RPC client for the MCP server (JSON and SSE replies) |
| `src/services/markdown.ts` | Markdown → JSON for tool answers that aren't JSON |
| `src/services/store.ts` | writes `data/` and prunes old runs |
| `src/services/scheduler.ts` | the in-process cron, with overlap handling |
| `src/services/lock.ts` | the cross-process run lock |
| `src/services/{format,log}.ts` | number/text helpers; stderr logger |
| `src/tools/catalog.ts` | the MCP calls fired per stock — 15 on the NSE, 12 on the BSE |
| `src/tools/dump.ts` | runs the catalogue and classifies each answer (the raw layer) |
| `src/tools/format.ts` | a raw dump → the document that ships |
| `crontab.txt` | the 5-minute schedule for a POSIX host |
| `run_every.ps1` | the same loop for a Windows host that wants PowerShell to own it |
| `n8n-workflows/moneycontrol-earnings-scraper.json` | the n8n workflow for this scraper |
| `n8n-workflows/univest-upcoming-results.json` | a separate pipeline: Univest API -> MCP -> "Sep 2026" filter |

## The MCP step

`src/tools/catalog.ts` builds one JSON-RPC `tools/call` per entry of the job
catalogue, fired at `MCP_ENDPOINT` in a fixed order so two runs of the same stock
diff cleanly:

search match · company overview · quarters · profit & loss · balance sheet ·
cash flow · ratios · peer comparison · RSI 14 / SMA 50 / EMA 200 / MACD, plus —
for an NSE listing only — NSE quote · announcements · corporate actions.

That is **15 calls for an NSE stock and 12 for a BSE-only one**. The catalogue is
exchange-aware on purpose: the screener tools take either identifier, but the
`nse_*` tools mean nothing off the NSE, and `technical_get_indicator` resolves to
a Yahoo ticker (`TECHNOCRAF.NS`, `541735.BO`), so asking for a symbol on the
exchange it isn't listed on returns nothing at best and another company's prices
at worst. (The previous catalogue asked for every indicator on *both* exchanges
for every symbol; half of those were meaningless.)

Each entry carries a **`slot`** — `profile`, `financials.quarters`,
`technicals.RSI14` — which is where its answer lands in the finished document.
The shape of a snapshot is decided in the catalogue, not by string-matching
labels downstream.

`MCP_CONCURRENCY` stocks are dumped at a time (default 2). One `tools/list` probe
runs first, so a dead endpoint is reported once instead of as the same connection
error repeated for every call of every symbol.

### Formatting

`src/tools/dump.ts` keeps every call verbatim — status, timing, the tool's own
text — because that is what you need when something breaks. `src/tools/format.ts`
turns that into what ships: each job's payload is placed at its slot, the
per-call bookkeeping is dropped, and the tool's raw text is not carried at all.
That is the difference between a snapshot of ~170 KB and one of several MB.

Reshaping, not just relaying:

* `topRatios: [{name, value}]` → `profile.ratios: {"Stock P/E": "32.6", …}`, so
  a ratio is addressable instead of something you iterate to find.
* `rows: [{label, values}]` → `financials.<statement>.rows: {"Sales": [...]}`,
  aligned with the statement's `periods` array.
* every indicator gets a `latest` alongside its `points`, since the newest
  reading is what a caller almost always wants.

A call that failed or was never made leaves its slot at its empty value and adds
an entry to **`issues`**. A call that legitimately had nothing to say ("no
corporate actions", "not enough history for a 200-day EMA") leaves the slot empty
and adds nothing. The two must not look the same downstream, and `issues` is what
keeps them apart:

```json
"issues": [
  {"slot": "quote", "label": "NSE LIVE QUOTE", "tool": "nse_get_quote",
   "reason": "failed",
   "error": "Error: NSE returned HTTP 403. Its anti-bot protection may be ..."}
]
```

`reason` is `failed` (the call errored) or `pending` (the run deadline arrived
before its turn).

## Output shape

One `results` entry per scanned stock: who it is, and what the MCP server said.

```json
{
  "ok": true,
  "runId": "20260904T074156Z",
  "source": "https://www.moneycontrol.com/markets/earnings/",
  "cacheEnabled": false,
  "scrapedAt": "2026-09-04T13:11:56.000+05:30",
  "durationMs": 17900,
  "counts": {"scanned": 10, "resolved": 10, "unresolved": 0,
             "ok": 10, "failed": 0, "pending": 0},
  "truncated": false,
  "results": [
    {
      "company": "Vivanta Industr",
      "scId": "VIVAN54173",
      "symbol": "541735",
      "exchange": "BSE",
      "events": ["reported"],
      "status": "ok",
      "error": null,
      "data": {
        "generatedAt": "2026-09-04T07:42:01.773Z",
        "profile": {
          "name": "Vivanta Industries Ltd",
          "screenerUrl": "https://www.screener.in/company/541735/consolidated/",
          "about": "Vivanta Industries Ltd (incorporated 31 May 2013 ...",
          "ratios": {"Market Cap": "₹ 23.8 Cr.", "Stock P/E": "22.9", "ROE": "3.50 %"},
          "pros": ["Debtor days have improved from 170 to 45.4 days."],
          "cons": ["Promoter holding is low: 10.6%"]
        },
        "financials": {
          "quarters": {
            "section": "Quarterly Results",
            "periods": ["Jun 2025", "Mar 2026", "Jun 2026"],
            "rows": {"Sales": ["91", "140", "93"], "Net Profit": ["4", "9", "5"]}
          },
          "profitAndLoss": {...}, "balanceSheet": {...},
          "cashFlow": {...}, "ratios": {...}
        },
        "peers": null,
        "quote": null,
        "announcements": [],
        "corporateActions": [],
        "technicals": {
          "RSI14": {"indicator": "RSI", "interval": "daily", "timePeriod": 14,
                    "latest": {"RSI": "58.28"},
                    "points": [{"date": "2026-09-04", "values": {"RSI": "58.28"}}]},
          "SMA50": {...}, "EMA200": {...}, "MACD": {...}
        },
        "matches": [{"id": "1286084", "name": "Vivanta Industries Ltd",
                     "url": "https://www.screener.in/company/541735/"}],
        "counts": {"total": 12, "ok": 11, "failed": 1, "empty": 0, "pending": 0},
        "issues": [{"slot": "peers", "label": "PEER COMPARISON",
                    "tool": "screener_get_peer_comparison", "reason": "failed",
                    "error": "Error: Couldn't find a peer comparison table ..."}]
      }
    }
  ],
  "files": {"latest": "...", "run": "...", "history": "...", "symbols": ["..."]}
}
```

`status` is one of:

| Value | Meaning |
|---|---|
| `ok` | dumped from the MCP server (possibly with some `issues`) |
| `failed` | every call for this stock failed; `error` says why |
| `pending` | the run deadline arrived first — the next tick picks it up, not a failure |
| `unresolved` | the price feed had neither an NSE ticker nor a BSE code; `data` is `null` |

No dedup is done across runs — every run emits the current full scan, and n8n
decides what is new. (Within a run, a company appearing in both sections is
collapsed to one entry carrying both `events`, so it is never dumped twice.)

## Generated data

Every tick rewrites `data/` (override with `DATA_DIR`, disable with
`WRITE_DATA_FILES=0`):

```
data/latest.json                  the newest snapshot — what n8n and dashboards read
data/runs/earnings-<runId>.json   one file per run, pruned to KEEP_RUNS (default 50)
data/symbols/<SYMBOL>.json        the newest formatted result per symbol
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

`SIGINT`/`SIGTERM` (`SIGINT`/`SIGBREAK` on Windows) stop the scheduler: between
ticks it shuts down cleanly, and during a pass the run is cut short and its lock
released rather than left behind. Snapshots are written to a `.tmp` file and
renamed, so an interrupted run can't leave a half-written document either way.

Windows can't deliver `SIGTERM` to a Node process at all — a killed run there
leaves its lock file, and the next run steals it on the dead-pid check.

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
| `MCP_CONCURRENCY` | `2` | stocks dumped in parallel |
| `MCP_TIMEOUT_MS` | `30000` | per MCP call — short on purpose; 12–15 calls × N stocks |
| `RUN_DEADLINE_MS` | `240000` | ceiling on one pass; the rest come back `pending` (0 = no ceiling) |
| `DATA_DIR` | `./data` | where snapshots are written |
| `KEEP_RUNS` | `50` | snapshots kept under `data/runs/` (0 = keep all) |
| `WRITE_DATA_FILES` | `1` | set to `0` for stdout-only runs |
| `LOCK_STALE_MS` | `RUN_DEADLINE_MS + 90000` | backstop age at which a lock is stolen (a dead pid is stolen at once) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## n8n

`n8n-workflows/moneycontrol-earnings-scraper.json` — import it into n8n. It is
built like `screener-mcp-server`'s supervisor workflow: check the repo out
inside the container, install, build, then run the CLI.

> **A workflow is a manual import.** The Clone/Build node pulls the *scraper
> source* from git, so code changes reach the container on the next tick — but
> the workflow itself lives in n8n's own database and nothing updates it.
> Editing the JSON in this repo changes a file the container never reads, so
> **re-import after every change**. The failure mode is quiet: a stale Split
> node reading fields the new snapshot no longer has produces
> `{"ok":true,"skipped":true,"reason":"no companies listed on the page right now"}`,
> which looks exactly like a scrape that found nothing.

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
  stock, each carrying its formatted MCP data under `data` and a `status` of
  `ok` / `pending` / `failed` / `unresolved`) and everything else — skipped ticks,
  build failures, scan errors, the hard timeout — to **Skipped Or Failed**.

  `results` is already one entry per company, so the split is a plain fan-out:
  there is no scraped row left to match a dump back to.

Nothing needs `python3` any more: the n8n image ships Node, which is all this
build step and the scraper need.

### When a pass takes too long

The **Run Scraper** node's stderr is the log. Each symbol logs its own line
(`MCP dump CRSL done in 3.1s (ok 13, failed 2, empty 6)`), so a slow pass points
straight at whichever call is dragging — usually the MCP server itself being
cold, rate-limited by screener.in, or blocked by NSE from inside the container.
If you see `run deadline reached — N stock(s) left partial or undumped`, either
the endpoint is unhealthy or `RUN_DEADLINE_MS` needs raising along with the
cadence.

If instead every execution ends at **Skipped Or Failed** with
`run already in progress`, a previous run was killed and left its lock behind.
The next tick now steals it automatically (dead pid); to clear one by hand:

```bash
docker exec <n8n-container> rm -f /home/node/.n8n/cron_scrapper/.scraper.lock
```

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

## The Univest workflow

`n8n-workflows/univest-upcoming-results.json` — a second, independent pipeline.
It does not use this repo's scraper at all: the stock list comes from Univest's
own API instead of from Moneycontrol, and the only thing it asks the MCP server
for is the quarterly results table.

```
Manual Trigger ─┐
Every 5 minutes ─┼→ Build MCP Server → Start If Not Running → Wait 5s → Health Check → Healthy?
Called By Supervisor ─┘                                                                    │
   ┌───────────────────────────────────────────── true ─────────────────────────────────────┘
   ↓
Fetch Upcoming Results → Flatten → Query Screener MCP → Filter On Sep 2026 Column
                                                                    ↓
                                                    Write Run Log → Return Qualified Data

   └── false → Dump MCP Log → Build Health Failure → Write Health Failure → MCP Unhealthy
```

The MCP half — build, start, wait, `tools/list` probe — is lifted verbatim from
the supervisor workflow, so nothing downstream can ever query a dead endpoint.

* **Fetch Upcoming Results** — `GET api.univest.in/resources/stock-details/upcoming-results`
  with a bearer token. It answers stocks grouped by result date:

  ```json
  {"data": {"2026-09-07": [{"finCode": 303646, "compName": "Kotyark Industries Ltd.",
                            "nseSymbol": "KOTYARK-BE", "bseSymbol": "KOTYARK", ...}]}}
  ```

  `fullResponse` is on, so a non-200 is logged with its body rather than
  aborting the run.

* **Flatten Upcoming Results** — date buckets to one item per stock, and this is
  where the **series suffix comes off**. The API returns the NSE *trading*
  symbol, which carries the series: `DHTL-SM` (SME board), `KOTYARK-BE` (book
  entry), also `-BZ` / `-BL` / `-ST`. screener.in only knows the bare ticker —
  `/company/DHTL-SM/` is a 404 and `/company/DHTL/` is not — so every one of
  those stocks would silently fail without the strip. A symbol that will not
  reduce to `^[A-Za-z0-9][A-Za-z0-9&.-]*$` is marked `usable: false` and never
  reaches the shell.

* **Query Screener MCP** — one `node -e` per stock, posting a single
  `tools/call` for `screener_get_financial_statement` (`quarters`). It falls
  back from consolidated to standalone when consolidated is missing or empty,
  never exits non-zero, and always prints exactly one JSON document.

  > The script is inlined into `node -e '...'`, so it deliberately contains **no
  > single quote anywhere** — double quotes and backticks only. The generator
  > refuses to build if one creeps in. Keep that rule when editing it.

* **Filter On Sep 2026 Column** — the parser and the filter. See below.

* **Write Run Log** — one shell run per execution (not per stock) appending the
  three log files.

* **Return Qualified Data** — one item per qualifying stock. When nothing
  qualifies it emits a single run summary instead; that is a normal outcome, not
  an error.

### The parser

The MCP server sends **both** forms of every answer: Markdown in
`result.content[].text`, and the same table as JSON in
`result.structuredContent`. The workflow prefers `structuredContent` and falls
back to a Markdown table parser, so a statement always reaches the filter as one
shape regardless of which the server produced:

```json
{"section": "Quarterly Results",
 "periods": ["Sep 2022", "Dec 2022", "Mar 2023", "Mar 2024", "Mar 2025", "Dec 2025", "Mar 2026"],
 "rows": {"Sales": ["14.32", "35.65", "78.16", "143.76", "19.86", "103.89", "63.66"],
          "Net Profit": [...]}}
```

`rows` is keyed by line item and every array lines up with `periods`, so a
figure is addressable by name and quarter rather than by position in a list.
Which path was taken shows up as `via: "structuredContent" | "markdown"` on the
output and in the logs.

### The filter

A stock's data is returned **only** when its quarterly table actually has the
target column:

```js
const TARGET_PERIOD = 'Sep 2026';   // top of "Filter On Sep 2026 Column"
```

That one line is the whole gate, and it is the one thing to change when the
quarter rolls over. Matching ignores case and surrounding whitespace and treats
`Sept 2026` as `Sep 2026`.

> **Expect zero qualifiers for a while.** The Sep-2026 quarter has not ended
> yet, so no company has filed it and nothing will match. That is the workflow
> working: it is a detector for the moment the new column appears, and it will
> start returning stocks as companies file. To watch it fire on real data now,
> point `TARGET_PERIOD` at a quarter that exists — with `Mar 2026` the current
> list qualifies `KOTYARK` and returns its full table.

### The logs

`/home/node/.n8n/univest-results/logs/`, one JSON object per line, appended on
every run — both outcomes, so the files are a complete record and not just a
record of the good runs.

| File | One line per |
|---|---|
| `qualified.jsonl` | stock that had the target column |
| `failures.jsonl` | stock that did not qualify, errored, or was skipped |
| `runs.jsonl` | run — the counts, so you can see coverage at a glance |

**Qualified** — which stock, and when it qualified (`ts` is the run that first
saw the column; `resultDate` is when the company was due to report):

```json
{"ts":"2026-09-04T09:54:43.377Z","runId":"20260904T095440Z","event":"qualified",
 "company":"Kotyark Industries Ltd.","symbol":"KOTYARK","rawSymbol":"KOTYARK-BE",
 "exchange":"NSE","finCode":303646,"resultDate":"2026-09-07",
 "matchedPeriod":"Mar 2026","periods":["Sep 2022", ...],
 "via":"structuredContent","variant":"consolidated"}
```

**Failure** — when, why, and the payload it failed for:

```json
{"ts":"2026-09-04T09:54:43.377Z","event":"failed","stage":"mcp-tool",
 "company":"SSPN Finance Ltd.","symbol":"SSPNFIN","resultDate":"2026-09-07",
 "reason":"the screener MCP server could not return quarterly results",
 "error":"Error: Screener.in returned 404 for https://www.screener.in/company/SSPNFIN/consolidated/ ...",
 "payload":{"variant":"consolidated","raw":"...","apiRecord":{"finCode":273425, ...}}}
```

`payload.apiRecord` is the untouched API record, so any failure can be replayed
against the exact input that produced it. `stage` says where it broke:

| `event` / `stage` | Meaning |
|---|---|
| `not-qualified` / `filter` | the table came back fine, it just has no target column |
| `failed` / `mcp-tool` | screener 404, a delisted scrip, a bad ticker |
| `failed` / `mcp-query` | the `node -e` call printed nothing parseable |
| `failed` / `parse` | neither `structuredContent` nor a Markdown table |
| `failed` / `pairing` | an answer came back for the wrong stock (should never fire) |
| `failed` / `mcp-health` | the MCP server was down; no stock was checked at all |
| `skipped` / `symbol` | the API record had no usable ticker |

> ⚠ **The bearer token is inline in the workflow JSON**, on the
> **Fetch Upcoming Results** node, and this file is in git — so it is in the
> history from the commit that added it. Before this leaves testing, move it to
> an n8n credential (Header Auth) and rotate the one that is checked in.

> Like every workflow here, this one is a **manual import**. Nothing in the
> pipeline updates n8n from the repo — editing the JSON here changes a file the
> container never reads. Re-import after every change.

## Notes on the data source

* The site is behind Akamai — requests need a browser `User-Agent`, which
  `USER_AGENT` supplies. `HTTP_RETRIES`/`HTTP_BACKOFF_MS` handle transient 503s.
* Symbols come from `priceapi.moneycontrol.com/pricefeed/{nse|bse}/equitycash/{scId}`:
  `NSEID` first, then `BSEID`. The `scId` from the page is authoritative — the
  trailing token in the stock URL is a *different* id and resolves to the wrong
  company.
* `nse_get_quote` returning HTTP 403 is NSE's anti-bot protection and is common;
  it lands in the stock's `issues` and the announcements and corporate-actions
  tools usually still work in the same pass.
* `screener_get_peer_comparison` fails for most small caps ("Couldn't find a peer
  comparison table") — screener.in simply has no table for them. Expect it in
  `issues`; it is not a fault of this scraper or of the MCP server.
* If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the
  page or is blocking the request. That is the one failure mode worth alerting
  on.
