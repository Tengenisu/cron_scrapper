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
`nseSymbols` list.

Python 3.9+, standard library only — no `requests`, no `beautifulsoup`, no headless
browser: the page is a Next.js app and both sections are server-rendered into the
`__NEXT_DATA__` blob, which is what the scraper reads.

## Files

| File | Purpose |
|---|---|
| `scraper.py` | fetch → parse → resolve NSE symbols → run the MCP node query → print JSON |
| `md_to_json.py` | converts the Markdown returned by the node/MCP query into JSON |
| `config.py` | all tunables; every one is overridable by an env var of the same name |
| `crontab.txt` | the 09:00–01:00 / 30-minute schedule |
| `symbol_cache.json` | generated: scId → NSE symbol, so the price feed isn't re-hit every scan |

## Usage

```bash
python scraper.py                  # both sections, compact JSON on stdout
python scraper.py --pretty         # indented
python scraper.py --section rapid  # RAPID RESULTS only
python scraper.py --section calendar
python scraper.py --no-node        # skip the MCP node step (scrape only)
python scraper.py --symbols-only   # just NSE symbols, one per line
python scraper.py --out data.json  # also write the JSON to a file
```

Failures are reported as `{"ok": false, "error": "..."}` on stdout with exit code 1,
so the n8n Execute Command node always has parseable output. Logs go to stderr.

## The MCP / `node -e` step

Set `NODE_CMD` in `config.py` (or as an env var). `{symbol}` is replaced with the
resolved NSE symbol:

```python
NODE_CMD = 'node -e "...your MCP query using {symbol}..."'
```

The command is run once per unique symbol. Its Markdown stdout is parsed by
`md_to_json.py` and attached under `mcp[]`:

```json
{"symbol": "DHOOTTRANS", "ok": true,
 "data": {"sections": [...], "fields": {...}, "tables": [[...]], "raw": "<markdown>"}}
```

`fields` merges every `Key: value` / `**Key:** value` line, `tables` flattens every
Markdown table into row objects with numeric cells coerced to numbers, and fenced
` ```json ` blocks are parsed into `blocks[].data`. `raw` keeps the original Markdown
so nothing is lost if the shape changes.

Non-zero exits are captured as `{"symbol": ..., "ok": false, "exitCode": N, "error": "..."}`
rather than aborting the run.

## Output shape

```json
{
  "ok": true,
  "source": "https://www.moneycontrol.com/markets/earnings/",
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

`crontab.txt` runs the scraper every 30 minutes from 09:00 to 01:00 IST
(covering both the 09:00–15:30 market window and the 15:30–01:00 results window).
Point `CRON_TZ`/paths at wherever the workflow is deployed, or drive the same
expressions from an n8n Schedule Trigger instead.

## Notes on the data source

* The site is behind Akamai — requests need a browser `User-Agent`, which
  `config.USER_AGENT` supplies. `HTTP_RETRIES`/`HTTP_BACKOFF` handle transient 503s.
* NSE symbols come from `priceapi.moneycontrol.com/pricefeed/{nse|bse}/equitycash/{scId}`
  (`NSEID` field). The `scId` from the page is authoritative — the trailing token in
  the stock URL is a *different* id and resolves to the wrong company.
* If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the page
  or is blocking the request; that is the one failure mode worth alerting on.
