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

# Cache of scId -> NSE symbol so we do not hit the price feed for the same
# company on every 30-minute scan.
SYMBOL_CACHE = os.getenv(
    "SYMBOL_CACHE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "symbol_cache.json")
)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# ---------------------------------------------------------------------------
# The MCP / node step.
#
# PASTE YOUR `node -e` QUERY HERE. Use {symbol} where the NSE symbol goes; it is
# substituted with the resolved symbol (e.g. DHOOTTRANS) before execution.
# The command is expected to print Markdown on stdout, which the scraper then
# converts to JSON.
#
# Example:
#   NODE_CMD = 'node -e "require(\'./mcp.js\').run(\'{symbol}\')"'
# ---------------------------------------------------------------------------
NODE_CMD = os.getenv("NODE_CMD", "")

NODE_TIMEOUT = float(os.getenv("NODE_TIMEOUT", "120"))
NODE_CWD = os.getenv("NODE_CWD", "") or None
