import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every tunable in one place. Each one is overridable by an environment variable
 * of the same name, which is how cron / n8n / Render configure this without
 * touching code.
 */

/** dist/constants.js -> the project root that owns data/, crontab.txt, etc. */
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? fallback : raw;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(`[config] ${name}="${raw}" is not a number — falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

// --------------------------------------------------------------------------- //
// Sources
// --------------------------------------------------------------------------- //

export const EARNINGS_URL = envString("EARNINGS_URL", "https://www.moneycontrol.com/markets/earnings/");

/**
 * Moneycontrol's price feed — the only way to translate a Moneycontrol scId
 * (e.g. "DTL03") into an NSE trading symbol (e.g. "DHOOTTRANS"). The scId from
 * the page is authoritative; the trailing token in the stock URL is a *different*
 * id and resolves to the wrong company.
 */
export const PRICE_FEED_URL = envString(
  "PRICE_FEED_URL",
  "https://priceapi.moneycontrol.com/pricefeed/{exchange}/equitycash/{scId}"
);

// --------------------------------------------------------------------------- //
// HTTP
// --------------------------------------------------------------------------- //

export const REQUEST_TIMEOUT_MS = envNumber("REQUEST_TIMEOUT_MS", 20_000);
export const HTTP_RETRIES = envNumber("HTTP_RETRIES", 3);
export const HTTP_BACKOFF_MS = envNumber("HTTP_BACKOFF_MS", 2_000);
/** Spacing between outgoing requests — Moneycontrol sits behind Akamai, don't hammer it. */
export const MIN_REQUEST_INTERVAL_MS = envNumber("MIN_REQUEST_INTERVAL_MS", 250);

export const USER_AGENT = envString(
  "USER_AGENT",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
);

export const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// --------------------------------------------------------------------------- //
// Caching — DISABLED.
//
// TESTING MODE: nothing is cached. Every run re-fetches the earnings page (with
// a cache-busting query param), re-resolves every scId against the price feed,
// and re-runs every MCP call, so each tick produces freshly generated data.
// Set CACHE_ENABLED=1 to turn the response cache and the on-disk symbol cache on.
// --------------------------------------------------------------------------- //

export const CACHE_ENABLED = envBool("CACHE_ENABLED", false);
export const CACHE_TTL_MS = envNumber("CACHE_TTL_MS", 5 * 60 * 1000);
export const SYMBOL_CACHE_FILE = CACHE_ENABLED
  ? envString("SYMBOL_CACHE_FILE", path.join(PROJECT_ROOT, "data", "symbol-cache.json"))
  : "";

// --------------------------------------------------------------------------- //
// The MCP step
//
// Each resolved NSE symbol is dumped from the screener MCP server: one JSON-RPC
// tools/call per entry in the job catalogue (see src/tools/catalog.ts).
// --------------------------------------------------------------------------- //

export const MCP_ENDPOINT = envString("MCP_ENDPOINT", "http://127.0.0.1:3123/mcp");
/**
 * Per MCP call. Deliberately short: 19 calls x N symbols means a generous
 * timeout here is what turns one slow upstream into a pass that runs for ten
 * minutes. A screener call that hasn't answered in 30s is not going to.
 */
export const MCP_TIMEOUT_MS = envNumber("MCP_TIMEOUT_MS", 30_000);
/** How many symbols are dumped at once. Keep it low; the MCP server throttles upstream anyway. */
export const MCP_CONCURRENCY = Math.max(1, envNumber("MCP_CONCURRENCY", 2));
export const MCP_CONSOLIDATED = envBool("MCP_CONSOLIDATED", true);
export const MCP_LIST_LIMIT = envNumber("MCP_LIST_LIMIT", 10);

// --------------------------------------------------------------------------- //
// Schedule
//
// TESTING MODE: every 5 minutes. `npm run cron` runs the schedule in-process
// (works on Windows, where there is no crond); crontab.txt has the same cadence
// for a POSIX host that would rather own the schedule itself.
// --------------------------------------------------------------------------- //

/**
 * Hard ceiling on one pass, so a slow or half-dead MCP server can never run past
 * the next tick. When it is hit, the symbols still queued come back as
 * `pending` and the snapshot is marked `truncated` — a partial answer, written
 * and returned on time, beats a run that never ends. 0 disables the ceiling.
 *
 * Keep it below CRON_SCHEDULE's interval; 4 minutes under a 5-minute cadence.
 */
export const RUN_DEADLINE_MS = envNumber("RUN_DEADLINE_MS", 4 * 60 * 1000);

export const CRON_SCHEDULE = envString("CRON_SCHEDULE", "*/5 * * * *");
export const CRON_TIMEZONE = envString("CRON_TIMEZONE", "Asia/Kolkata");
/** Fire one pass immediately on startup instead of idling until the first tick. */
export const RUN_ON_START = envBool("RUN_ON_START", true);

// --------------------------------------------------------------------------- //
// Generated data
// --------------------------------------------------------------------------- //

export const DATA_DIR = envString("DATA_DIR", path.join(PROJECT_ROOT, "data"));
export const WRITE_DATA_FILES = envBool("WRITE_DATA_FILES", true);
/** Snapshots kept under data/runs/ before the oldest are pruned. 0 = keep everything. */
export const KEEP_RUNS = envNumber("KEEP_RUNS", 50);

// --------------------------------------------------------------------------- //
// Run lock
//
// A pass over ~8 symbols takes minutes, which is close enough to the 5-minute
// cadence that ticks can overlap. Runs are serialised with a lock file: a tick
// that finds a run in flight exits immediately with {"ok": true, "skipped": true}.
//
// The lock records its owner's pid, and one whose pid is gone is stolen on the
// spot — otherwise a run killed by a cancelled n8n execution or by `timeout`
// leaves a file that makes every later tick skip, which looks exactly like a
// scraper that has stopped working. LOCK_STALE_MS is only the backstop for the
// case the pid check can't see (pid reuse, another host on a shared volume), so
// it is tied to the run deadline rather than being an arbitrary 15 minutes.
// --------------------------------------------------------------------------- //

export const LOCK_FILE = envString("LOCK_FILE", path.join(PROJECT_ROOT, ".scraper.lock"));
export const LOCK_STALE_MS = envNumber(
  "LOCK_STALE_MS",
  RUN_DEADLINE_MS > 0 ? RUN_DEADLINE_MS + 90_000 : 15 * 60 * 1000
);

export const LOG_LEVEL = envString("LOG_LEVEL", "info").toLowerCase();
