#!/usr/bin/env python3
"""Moneycontrol earnings scraper.

Scrapes https://www.moneycontrol.com/markets/earnings/ for

  * RESULT CALENDAR -- companies about to release quarterly results
  * RAPID RESULTS   -- companies that have just posted results

resolves each company to its NSE trading symbol, optionally runs the MCP
`node -e` query per symbol (converting its Markdown answer to JSON), and prints
one JSON document on stdout for the n8n workflow to consume.

The page is a Next.js app: both sections are server-rendered into the
``__NEXT_DATA__`` script tag, so no headless browser is required.

Usage::

    python scraper.py                 # both sections, JSON to stdout
    python scraper.py --section rapid # rapid results only
    python scraper.py --no-node       # skip the MCP enrichment
    python scraper.py --out data.json # also write to a file
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request

import config
from md_to_json import dump_to_dict

log = logging.getLogger("earnings")

NEXT_DATA_START = '<script id="__NEXT_DATA__" type="application/json">'
NEXT_DATA_END = "</script>"

# Moneycontrol group codes -> exchange segment used by the price feed.
_EXCHANGE_SEGMENT = {"N": "nse", "B": "bse"}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def http_get(url: str, referer: str | None = None) -> str:
    """GET a URL with browser-ish headers, retrying on transient failures."""
    headers = {
        "User-Agent": config.USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
    }
    if referer:
        headers["Referer"] = referer

    last_error: Exception | None = None
    for attempt in range(1, config.HTTP_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=config.HTTP_TIMEOUT) as resp:
                charset = resp.headers.get_content_charset() or "utf-8"
                return resp.read().decode(charset, errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as exc:
            last_error = exc
            log.warning("GET %s failed (attempt %d/%d): %s", url, attempt, config.HTTP_RETRIES, exc)
            if attempt < config.HTTP_RETRIES:
                time.sleep(config.HTTP_BACKOFF * attempt)
    raise RuntimeError("could not fetch %s: %s" % (url, last_error))


def extract_next_data(html: str) -> dict:
    """Pull the __NEXT_DATA__ JSON blob out of the page source."""
    start = html.find(NEXT_DATA_START)
    if start == -1:
        raise RuntimeError("__NEXT_DATA__ not found -- page layout changed or request was blocked")
    start += len(NEXT_DATA_START)
    end = html.find(NEXT_DATA_END, start)
    if end == -1:
        raise RuntimeError("__NEXT_DATA__ script tag is not terminated")
    return json.loads(html[start:end])


# --------------------------------------------------------------------------- #
# NSE symbol resolution
# --------------------------------------------------------------------------- #
class SymbolResolver:
    """scId -> NSE symbol, backed by a JSON file cache.

    With ``enabled=False`` (the default in testing mode) nothing is remembered
    and nothing is written: every scId is looked up live on every run.
    """

    def __init__(self, cache_path: str, enabled: bool = True):
        self.enabled = bool(enabled and cache_path)
        self.cache_path = cache_path if self.enabled else ""
        self.cache: dict[str, str | None] = {}
        self._dirty = False
        if self.enabled and os.path.exists(cache_path):
            try:
                with open(cache_path, encoding="utf-8") as fh:
                    self.cache = json.load(fh)
            except (ValueError, OSError) as exc:
                log.warning("ignoring unreadable symbol cache %s: %s", cache_path, exc)

    def resolve(self, sc_id: str | None, exchange: str = "N") -> str | None:
        if not sc_id:
            return None
        if self.enabled and sc_id in self.cache:
            return self.cache[sc_id]

        symbol = None
        # Try the stock's own segment first, then NSE -- a BSE-grouped scrip can
        # still carry an NSEID, and vice versa.
        segments = [_EXCHANGE_SEGMENT.get((exchange or "N").upper(), "nse")]
        if "nse" not in segments:
            segments.append("nse")
        for segment in segments:
            url = config.PRICE_API.format(exchange=segment, sc_id=sc_id)
            try:
                payload = json.loads(http_get(url))
            except (RuntimeError, ValueError) as exc:
                log.warning("price feed failed for %s (%s): %s", sc_id, segment, exc)
                continue
            data = (payload or {}).get("data") or {}
            candidate = (data.get("NSEID") or "").strip()
            if candidate and candidate not in {"-", "--"}:
                symbol = candidate
                break

        if symbol is None:
            log.info("no NSE symbol for scId=%s (exchange=%s)", sc_id, exchange)
        if self.enabled:
            self.cache[sc_id] = symbol
            self._dirty = True
        return symbol

    def save(self) -> None:
        if not (self.enabled and self._dirty):
            return
        # Only successful lookups are persisted: a BSE-only scrip may get listed
        # on the NSE later, and a cached null would hide it forever.
        resolved = {k: v for k, v in self.cache.items() if v}
        try:
            tmp = self.cache_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(resolved, fh, indent=1, sort_keys=True)
            os.replace(tmp, self.cache_path)
        except OSError as exc:
            log.warning("could not write symbol cache: %s", exc)


# --------------------------------------------------------------------------- #
# Section parsers
# --------------------------------------------------------------------------- #
def _num(value):
    if value in (None, "", "-", "--"):
        return None
    try:
        return float(str(value).replace(",", ""))
    except ValueError:
        return None


def parse_result_calendar(earnings: dict) -> list[dict]:
    """RESULT CALENDAR -- companies about to release quarterly numbers."""
    block = earnings.get("resCalData") or {}
    out = []
    for row in block.get("list") or []:
        out.append(
            {
                "date": row.get("date"),
                "company": row.get("stockName"),
                "shortName": row.get("stockShortName"),
                "scId": row.get("scId"),
                "exchange": row.get("exchange"),
                "resultType": row.get("resultType"),
                "ltp": _num(row.get("ltp")),
                "changePercent": _num(row.get("change")),
                "time": row.get("time"),
                "marketCap": row.get("marketCap"),
                "url": row.get("stockUrl"),
                "financialsUrl": row.get("seeFinancial"),
            }
        )
    return out


def parse_rapid_results(earnings: dict) -> list[dict]:
    """RAPID RESULTS -- companies that have already posted results."""
    block = earnings.get("rapResData") or {}
    base_url = block.get("baseURL") or ""
    names = [h.get("name") for h in block.get("header") or []]
    columns = block.get("tableHeader") or []
    out = []
    for row in block.get("list") or []:
        rec = dict(zip(names, row))
        quarters = []
        for metric in rec.get("quarterData") or []:
            metric = list(metric) + [None] * (4 - len(metric))
            quarters.append(
                {
                    "metric": metric[0],
                    "current": _num(metric[1]),
                    "previous": _num(metric[2]),
                    "growthPercent": _num(metric[3]),
                }
            )
        seo = rec.get("seoString") or ""
        out.append(
            {
                "date": rec.get("date"),
                "company": rec.get("stockName"),
                "scId": rec.get("scID") or rec.get("scId"),
                "exchange": rec.get("exchange"),
                "ltp": _num(rec.get("ltp")),
                "changePercent": _num(rec.get("changeP")),
                "financialType": rec.get("financialType"),
                "period": columns[0] if columns else None,
                "columns": columns,
                "quarterData": quarters,
                "url": (base_url + seo) if seo else None,
            }
        )
    return out


# --------------------------------------------------------------------------- #
# MCP / node step
# --------------------------------------------------------------------------- #
def run_node_query(symbol: str) -> dict | None:
    """Run the configured `node -e` MCP query for one NSE symbol.

    The command prints Markdown on stdout; it is converted to JSON here.
    """
    if not config.NODE_CMD:
        return None

    command = config.NODE_CMD.replace("{symbol}", symbol)
    env = dict(os.environ, MCP_ENDPOINT=config.MCP_ENDPOINT, SYMBOL=symbol)
    log.info("node query for %s", symbol)
    try:
        proc = subprocess.run(
            command if os.name == "nt" else shlex.split(command),
            shell=os.name == "nt",
            capture_output=True,
            text=True,
            timeout=config.NODE_TIMEOUT,
            cwd=config.NODE_CWD,
            env=env,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        log.error("node query failed for %s: %s", symbol, exc)
        return {"symbol": symbol, "ok": False, "error": str(exc)}

    if proc.returncode != 0:
        log.error("node query for %s exited %d: %s", symbol, proc.returncode, (proc.stderr or "").strip()[:500])
        return {
            "symbol": symbol,
            "ok": False,
            "exitCode": proc.returncode,
            "error": (proc.stderr or "").strip()[:2000],
        }

    return {"symbol": symbol, "ok": True, "data": dump_to_dict(proc.stdout)}


# --------------------------------------------------------------------------- #
# Run lock -- keeps 5-second ticks from stacking on top of each other
# --------------------------------------------------------------------------- #
class RunLock:
    """Best-effort cross-platform single-run lock built on O_EXCL."""

    def __init__(self, path: str, stale_after: float):
        self.path = path
        self.stale_after = stale_after
        self.held = False

    def acquire(self) -> bool:
        if not self.path:
            return True
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if not self._steal_if_stale():
                    return False
                continue
            except OSError as exc:
                log.warning("cannot create lock %s: %s", self.path, exc)
                return True
            with os.fdopen(fd, "w") as fh:
                fh.write("{} {}".format(os.getpid(), time.time()))
            self.held = True
            return True
        return False

    def _steal_if_stale(self) -> bool:
        try:
            age = time.time() - os.path.getmtime(self.path)
        except OSError:
            return True  # vanished between calls -- retry the create
        if age < self.stale_after:
            return False
        log.warning("stealing stale lock %s (%.0fs old)", self.path, age)
        try:
            os.unlink(self.path)
        except OSError:
            return False
        return True

    def release(self) -> None:
        if not self.held:
            return
        try:
            os.unlink(self.path)
        except OSError as exc:
            log.warning("could not remove lock %s: %s", self.path, exc)
        self.held = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release()


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def scrape(sections: str = "both", enrich: bool = True) -> dict:
    url = config.EARNINGS_URL
    if not config.CACHE_ENABLED:
        # defeat any CDN/proxy copy so each run really re-reads the page
        url += ("&" if "?" in url else "?") + "_=%d" % time.time()
    html = http_get(url)
    next_data = extract_next_data(html)
    earnings = next_data["props"]["pageProps"]["earningsDashboardData"]

    result: dict = {
        "ok": True,
        "source": config.EARNINGS_URL,
        "cacheEnabled": config.CACHE_ENABLED,
        "scrapedAt": dt.datetime.now(dt.timezone.utc).astimezone().isoformat(),
        "calendarDate": earnings.get("resCalTodayDate"),
        "calendarRange": {
            "from": earnings.get("resCalFromDate"),
            "to": earnings.get("resCalToDate"),
        },
        "resultCalendar": [],
        "rapidResults": [],
    }

    if sections in ("both", "calendar"):
        result["resultCalendar"] = parse_result_calendar(earnings)
    if sections in ("both", "rapid"):
        result["rapidResults"] = parse_rapid_results(earnings)

    records = result["resultCalendar"] + result["rapidResults"]
    resolver = SymbolResolver(config.SYMBOL_CACHE, enabled=config.CACHE_ENABLED)
    for record in records:
        record["nseSymbol"] = resolver.resolve(record.get("scId"), record.get("exchange") or "N")
    resolver.save()

    symbols = sorted({r["nseSymbol"] for r in records if r.get("nseSymbol")})
    result["nseSymbols"] = symbols
    result["counts"] = {
        "resultCalendar": len(result["resultCalendar"]),
        "rapidResults": len(result["rapidResults"]),
        "nseSymbols": len(symbols),
    }

    if enrich and config.NODE_CMD:
        result["mcp"] = [q for q in (run_node_query(s) for s in symbols) if q]
    elif enrich:
        log.info("NODE_CMD is empty -- skipping the MCP node step")

    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Scrape Moneycontrol earnings (result calendar + rapid results)"
    )
    parser.add_argument("--section", choices=["both", "calendar", "rapid"], default="both")
    parser.add_argument("--no-node", action="store_true", help="skip the MCP node query step")
    parser.add_argument("--out", help="also write the JSON to this file")
    parser.add_argument("--pretty", action="store_true", help="indent the JSON output")
    parser.add_argument("--symbols-only", action="store_true", help="print just the NSE symbols, one per line")
    parser.add_argument("--no-lock", action="store_true", help="run even if another run is in flight")
    args = parser.parse_args(argv)

    # the MCP dump carries rupee signs and em dashes; never die on a cp1252 console
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )

    lock = RunLock("" if args.no_lock else config.LOCK_FILE, config.LOCK_STALE_SECONDS)
    if not lock.acquire():
        # A 5-second tick landed while the previous pass is still running. This
        # is expected, not an error: n8n should treat it as "nothing new".
        log.info("another run is in flight -- skipping this tick")
        print(json.dumps({"ok": True, "skipped": True, "reason": "run already in progress"}))
        return 0

    try:
        data = scrape(sections=args.section, enrich=not args.no_node)
    except Exception as exc:  # cron/n8n needs parseable failure, not a traceback
        log.exception("scrape failed")
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    finally:
        lock.release()

    if args.symbols_only:
        for symbol in data["nseSymbols"]:
            print(symbol)
        return 0

    payload = json.dumps(data, indent=2 if args.pretty else None, ensure_ascii=False)
    print(payload)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
