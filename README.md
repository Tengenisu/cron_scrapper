# Moneycontrol earnings scraper

Scrapes [moneycontrol.com/markets/earnings](https://www.moneycontrol.com/markets/earnings/)
and emits one JSON document on stdout — the final step of the n8n workflow.

Two sections are captured:

| Section | Meaning |
|---|---|
| **RESULT CALENDAR** | companies *about to* release quarterly results (`Dhoot Transmiss · 1,615.50` rows) |
| **RAPID RESULTS** | companies that have *just posted* results, with Revenue / Gross Profit / Net Profit vs. the year-ago quarter |

Every company is resolved to its **NSE symbol** (`DTL03` → `DHOOTTRANS`). Stocks
listed only on the BSE come back with `nseSymbol: null` and are excluded from the
`nseSymbols` list. Each symbol is then dumped in full from the screener MCP server.

Python 3.9+, standard library only — no `requests`, no `beautifulsoup`, no headless
browser: the page is a Next.js app and both sections are server-rendered into the
`__NEXT_DATA__` blob, which is what the scraper reads.

## ⚠ Testing mode

The repo is currently configured for **testing**, not production:

* **Nothing is cached.** `CACHE_ENABLED=0`, `SYMBOL_CACHE` is empty, the earnings
  page is fetched with a cache-busting query param and the MCP calls send
  `Cache-Control: no-cache`. Every run regenerates every field from scratch.
* **The cadence is 5 seconds** (`RUN_INTERVAL_SECONDS=5`), around the clock.

To go back to normal: set `CACHE_ENABLED=1` and restore the 30-minute cron lines
commented at the bottom of `crontab.txt`.

A full pass over ~8 symbols × 19 MCP calls takes **about 3 minutes**, so a 5-second
tick nearly always lands on a run that is still going. That is handled, not ignored:
`scraper.py` takes a lock file (`.scraper.lock`), and an overlapping tick exits
immediately with

```json
{"ok": true, "skipped": true, "reason": "run already in progress"}
```

A lock older than `LOCK_STALE_SECONDS` (default 900) is treated as a crashed run and
stolen. `--no-lock` bypasses the whole mechanism.

## Files

| File | Purpose |
|---|---|
| `scraper.py` | fetch → parse → resolve NSE symbols → run the MCP query per symbol → print JSON |
| `mcp_query.js` | the full-dump MCP query (19 tool calls per symbol), run once per symbol |
| `md_to_json.py` | turns the dump into JSON (`dump_to_dict`) and Markdown into JSON (`markdown_to_dict`) |
| `config.py` | all tunables; every one is overridable by an env var of the same name |
| `crontab.txt` | the 5-second testing schedule (30-minute production lines kept as comments) |
| `run_every.sh` / `run_every.ps1` | the 5-second loop cron calls once a minute (POSIX / Windows) |
| `n8n-workflows/moneycontrol-earnings-scraper.json` | the n8n workflow, wired to the screener-mcp supervisor |

## Usage

```bash
python scraper.py                  # both sections, compact JSON on stdout
python scraper.py --pretty         # indented
python scraper.py --section rapid  # RAPID RESULTS only
python scraper.py --section calendar
python scraper.py --no-node        # skip the MCP step (scrape only)
python scraper.py --symbols-only   # just NSE symbols, one per line
python scraper.py --out data.json  # also write the JSON to a file
python scraper.py --no-lock        # run even if another pass is in flight

./run_every.sh forever             # 5-second loop in the foreground
node mcp_query.js TECHNOCRAF       # the MCP dump for one symbol, raw
```

Failures are reported as `{"ok": false, "error": "..."}` on stdout with exit code 1,
so the n8n Execute Command node always has parseable output. Logs go to stderr.

## The MCP step

`mcp_query.js` is the `node -e` full-dump query kept in a file so its quoting
survives cmd.exe, PowerShell and sh alike. It fires 19 JSON-RPC `tools/call`
requests at `MCP_ENDPOINT` (default `http://127.0.0.1:3123/mcp`) per symbol:

search match · company overview · quarters · profit & loss · balance sheet ·
cash flow · ratios · peer comparison · NSE quote · NSE announcements ·
NSE corporate actions · RSI 14 / SMA 50 / EMA 200 / MACD, on both NSE and BSE.

`config.NODE_CMD` runs it once per unique symbol with `{symbol}` substituted, and
`md_to_json.dump_to_dict` splits the dump on its `## LABEL   [tool_name]` headers:

```json
{"symbol": "TECHNOCRAF", "ok": true,
 "data": {
   "symbol": "TECHNOCRAF", "generatedAt": "2026-09-04T04:35:41.164Z",
   "counts": {"total": 19, "ok": 17, "failed": 2, "empty": 7},
   "jobs": [
     {"label": "QUARTERS", "tool": "screener_get_financial_statement",
      "ok": true, "error": null, "empty": false,
      "content": {"sections": [...], "fields": {...},
                  "tables": [[{"Line item": "Sales", "Jun 2026": 93}]]},
      "raw": "## Quarterly Results\n| Line item | ..."},
     {"label": "SEARCH MATCH", "tool": "screener_search_companies",
      "ok": true, "data": {"results": [...]}},
     {"label": "NSE LIVE QUOTE", "tool": "nse_get_quote",
      "ok": false, "error": "Error: NSE returned HTTP 403. ..."}
   ]}}
```

Per job: `data` holds parsed JSON when the tool returned JSON, `content` holds the
structured Markdown otherwise (`fields` merges `Key: value` lines, `tables` becomes
row objects with numeric cells coerced), and `raw` always keeps the original text so
nothing is lost if the shape changes. `ok: false` marks a real tool error;
`empty: true` marks a legitimate "no data" answer (no corporate actions, not enough
price history for a 200-day EMA) — the run is not failed by either.

Non-zero exits are captured as `{"symbol": ..., "ok": false, "exitCode": N, "error": "..."}`
rather than aborting the run.

## Output shape

```json
{
  "ok": true,
  "source": "https://www.moneycontrol.com/markets/earnings/",
  "cacheEnabled": false,
  "scrapedAt": "2026-09-04T09:45:00+05:30",
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
  "counts": {"resultCalendar": 1, "rapidResults": 9, "nseSymbols": 8},
  "mcp": [ ... ]
}
```

No dedup is done — every run emits the current full snapshot, and n8n decides what
is new.

## Schedule

`crontab.txt` fires `run_every.sh` once a minute; the script loops through the
minute at a 5-second cadence (cron itself cannot go below a minute). Point
`CRON_TZ`/paths at wherever this is deployed:

```cron
RUN_INTERVAL_SECONDS=5
CACHE_ENABLED=0
* * * * *  cd /opt/cron_scrapper && ./run_every.sh >> /var/log/earnings/cron.log 2>&1
```

On Windows: `powershell -ExecutionPolicy Bypass -File .\run_every.ps1`.

Run **either** cron or the n8n Schedule Trigger, not both, or every symbol gets
queried twice.

## n8n

`n8n-workflows/moneycontrol-earnings-scraper.json` — import it into n8n:

```
Manual Trigger ─┐
Every 5 seconds ─┼→ Sync Scraper Repo → Run Scraper → Parse Scraper JSON → Fresh Data?
Called By Supervisor ─┘                                                     ├→ Split Into Companies
                                                                            └→ Skipped Or Failed
```

* **Sync Scraper Repo** clones/pulls `github.com/Tengenisu/cron_scrapper` into
  `/home/node/.n8n/cron_scrapper`, mirroring the supervisor's build step.
* **Run Scraper** executes `scraper.py` with `CACHE_ENABLED=0` and
  `MCP_ENDPOINT=http://127.0.0.1:3123/mcp`.
* **Fresh Data?** routes real snapshots to **Split Into Companies** (one item per
  company, carrying its own MCP dump) and everything else — skipped ticks, scraper
  errors, unparseable output — to **Skipped Or Failed**.

### The n8n image has no Python

n8n's Docker image is Alpine + Node — it ships `node` but **not** `python3` (the
same reason the supervisor's build step hedges on `git` being missing). Both nodes
now resolve the interpreter with `command -v python3 || command -v python`:
**Sync Scraper Repo** prints a `SYNC_WARN` with the fix, and **Run Scraper** emits
`{"ok": false, "error": "no python interpreter ..."}` so the failure arrives as a
parseable document instead of empty stdout.

Install it once (it survives until the container is recreated):

```bash
docker exec -u root <n8n-container> apk add --no-cache python3
```

For anything permanent, bake `python3` into a custom n8n image, or run `scraper.py`
on the host and have n8n call it over SSH/webhook instead of Execute Command.
`scraper.py` is stdlib-only, so any Python ≥ 3.9 is enough — no pip install.

### Supervisor integration

`screener-mcp-server/n8n-workflows/screener-mcp-supervisor.json` has a new
**Run Earnings Scraper** node hanging off **Report Healthy**, so the scraper is
kicked only once the MCP server has answered `tools/list` successfully — it can
never query a dead endpoint. `waitForSubWorkflow` is off: a full pass takes minutes
and must not block the supervisor's 10-minute health loop.

After importing both workflows, open that node and set **Workflow** to the imported
scraper workflow (its `workflowId` currently reads
`REPLACE_WITH_MONEYCONTROL_SCRAPER_WORKFLOW_ID`).

## Notes on the data source

* The site is behind Akamai — requests need a browser `User-Agent`, which
  `config.USER_AGENT` supplies. `HTTP_RETRIES`/`HTTP_BACKOFF` handle transient 503s.
* NSE symbols come from `priceapi.moneycontrol.com/pricefeed/{nse|bse}/equitycash/{scId}`
  (`NSEID` field). The `scId` from the page is authoritative — the trailing token in
  the stock URL is a *different* id and resolves to the wrong company.
* `nse_get_quote` returning HTTP 403 is NSE's anti-bot protection and is common; the
  announcements/corporate-actions tools usually still work in the same pass.
* If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the page
  or is blocking the request; that is the one failure mode worth alerting on.
