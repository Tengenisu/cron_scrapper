"""Configuration for the Moneycontrol earnings scraper.

Every value can be overridden with an environment variable of the same name,
which is how n8n / cron should tune it without editing code.
"""
import os

EARNINGS_URL = os.getenv(
    "EARNINGS_URL", "https://www.moneycontrol.com/markets/earnings/"
)

# Moneycontrol price feed -- used to translate a Moneycontrol scId (e.g. "DTL03")
# into an NSE trading symbol (e.g. "DHOOTTRANS").
PRICE_API = os.getenv(
    "PRICE_API", "https://priceapi.moneycontrol.com/pricefeed/{exchange}/equitycash/{sc_id}"
)

HTTP_TIMEOUT = float(os.getenv("HTTP_TIMEOUT", "20"))
HTTP_RETRIES = int(os.getenv("HTTP_RETRIES", "3"))
HTTP_BACKOFF = float(os.getenv("HTTP_BACKOFF", "2"))

USER_AGENT = os.getenv(
    "USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
)

# --------------------------------------------------------------------------- #
# Caching -- DISABLED.
#
# TESTING MODE: nothing is cached. Every run re-resolves every scId against the
# Moneycontrol price feed and re-runs the MCP query, so each execution produces
# freshly generated data. Set CACHE_ENABLED=1 (and optionally SYMBOL_CACHE=path)
# to turn the on-disk symbol cache back on.
# --------------------------------------------------------------------------- #
CACHE_ENABLED = os.getenv("CACHE_ENABLED", "0").lower() in {"1", "true", "yes", "on"}

SYMBOL_CACHE = os.getenv("SYMBOL_CACHE", "") if CACHE_ENABLED else ""

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# --------------------------------------------------------------------------- #
# The MCP / node step.
#
# The full-dump query lives in mcp_query.js next to this file; {symbol} is
# replaced with the resolved NSE symbol (e.g. TECHNOCRAF) before execution.
# It is the same query as the `node -e "..."` one-liner, kept in a file so the
# quoting survives cmd.exe / PowerShell / sh alike.
#
# The command prints Markdown-ish sections on stdout, which md_to_json.py turns
# into JSON. Nothing is cached -- every symbol is queried live on every run.
# --------------------------------------------------------------------------- #
_HERE = os.path.dirname(os.path.abspath(__file__))

MCP_ENDPOINT = os.getenv("MCP_ENDPOINT", "http://127.0.0.1:3123/mcp")

NODE_CMD = os.getenv(
    "NODE_CMD", 'node "%s" {symbol}' % os.path.join(_HERE, "mcp_query.js")
)

NODE_TIMEOUT = float(os.getenv("NODE_TIMEOUT", "120"))
NODE_CWD = os.getenv("NODE_CWD", "") or _HERE

# How often the scraper should run, in seconds. TESTING MODE: 5 seconds.
# cron cannot go below a minute, so run_every.sh / run_every.ps1 loop inside the
# minute and the n8n Schedule Trigger uses a seconds interval.
RUN_INTERVAL_SECONDS = int(os.getenv("RUN_INTERVAL_SECONDS", "5"))

# A 5-second cadence fires far faster than one full pass takes (~3 min for
# ~8 symbols), so runs are serialised with a lock file: a tick that finds a run
# already in flight exits immediately with {"ok": true, "skipped": true}.
# A lock older than LOCK_STALE_SECONDS is treated as a crashed run and stolen.
LOCK_FILE = os.getenv("LOCK_FILE", os.path.join(_HERE, ".scraper.lock"))
LOCK_STALE_SECONDS = float(os.getenv("LOCK_STALE_SECONDS", "900"))
