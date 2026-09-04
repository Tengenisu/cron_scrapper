import {
  CACHE_ENABLED,
  EARNINGS_URL,
  LOCK_FILE,
  LOCK_STALE_MS,
  MCP_CONCURRENCY,
  MCP_ENDPOINT,
  RUN_DEADLINE_MS,
  WRITE_DATA_FILES,
} from "./constants.js";
import { RunLock } from "./services/lock.js";
import { checkMcpHealth } from "./services/mcp.js";
import { scrapeEarnings } from "./services/moneycontrol.js";
import { SymbolResolver } from "./services/symbols.js";
import { writeSnapshot } from "./services/store.js";
import { errorMessage, fileTimestamp, formatDuration, localIsoTimestamp, mapWithConcurrency } from "./services/format.js";
import { log } from "./services/log.js";
import { dumpSymbol } from "./tools/dump.js";
import type { CliOptions } from "./schemas/index.js";
import type { EarningsSnapshot, RunResult, SymbolDump } from "./types.js";

/**
 * One full pass: scrape → resolve NSE symbols → dump each symbol from the MCP
 * server → assemble one JSON document → write it to data/.
 *
 * No dedup is done. Every run emits the current full snapshot and n8n decides
 * what is new.
 */
export async function runOnce(options: Pick<CliOptions, "section" | "enrich" | "useLock">): Promise<RunResult> {
  const lock = new RunLock(options.useLock ? LOCK_FILE : "", LOCK_STALE_MS);
  if (!lock.acquire()) {
    // A tick landed while the previous pass is still running. Expected, not an
    // error: n8n should read this as "nothing new".
    log.info("another run is in flight — skipping this tick");
    return { ok: true, skipped: true, reason: "run already in progress" };
  }

  const startedAt = Date.now();
  try {
    const snapshot = await collect(options, startedAt);
    if (WRITE_DATA_FILES) snapshot.files = writeSnapshot(snapshot);
    log.info(
      `run ${snapshot.runId} finished in ${formatDuration(snapshot.durationMs)} — ` +
        `${snapshot.counts.nseSymbols} symbol(s), ${snapshot.counts.mcpFailed} MCP failure(s)` +
        `${snapshot.truncated ? `, ${snapshot.counts.mcpPending} pending (deadline)` : ""}`
    );
    return snapshot;
  } catch (err) {
    // cron and n8n need a parseable failure, never a stack trace on stdout.
    log.error(`run failed: ${errorMessage(err)}`);
    return { ok: false, error: errorMessage(err) };
  } finally {
    lock.release();
  }
}

async function collect(
  options: Pick<CliOptions, "section" | "enrich">,
  startedAt: number
): Promise<EarningsSnapshot> {
  const sections = await scrapeEarnings(options.section);
  const records = [...sections.resultCalendar, ...sections.rapidResults];

  const resolver = new SymbolResolver();
  for (const record of records) {
    record.nseSymbol = await resolver.resolve(record.scId, record.exchange);
  }
  resolver.save();

  // Stocks listed only on the BSE come back with nseSymbol: null and are
  // excluded here — there is nothing for the screener MCP server to look up.
  const symbols = [...new Set(records.map((r) => r.nseSymbol).filter((s): s is string => Boolean(s)))].sort();
  log.info(`resolved ${symbols.length} NSE symbol(s): ${symbols.join(", ") || "—"}`);

  // Everything above is cheap; the MCP step is what can drag, so the deadline is
  // measured from the start of the run and only ever cuts that step short.
  const deadlineAt = RUN_DEADLINE_MS > 0 ? startedAt + RUN_DEADLINE_MS : Infinity;
  const mcp = options.enrich ? await dumpSymbols(symbols, deadlineAt) : [];

  return {
    ok: true,
    runId: fileTimestamp(new Date(startedAt)),
    source: EARNINGS_URL,
    cacheEnabled: CACHE_ENABLED,
    scrapedAt: localIsoTimestamp(),
    durationMs: Date.now() - startedAt,
    calendarDate: sections.calendarDate,
    calendarRange: sections.calendarRange,
    resultCalendar: sections.resultCalendar,
    rapidResults: sections.rapidResults,
    nseSymbols: symbols,
    counts: {
      resultCalendar: sections.resultCalendar.length,
      rapidResults: sections.rapidResults.length,
      nseSymbols: symbols.length,
      mcpOk: mcp.filter((dump) => dump.ok).length,
      mcpFailed: mcp.filter((dump) => !dump.ok && !dump.pending).length,
      mcpPending: mcp.filter((dump) => dump.pending).length,
    },
    truncated: mcp.some((dump) => dump.pending || dump.data?.counts.pending),
    mcp,
  };
}

async function dumpSymbols(symbols: string[], deadlineAt: number): Promise<SymbolDump[]> {
  if (symbols.length === 0) return [];

  // One probe up front: a dead endpoint is worth reporting once, not as the same
  // connection error repeated 19 times per symbol.
  const health = await checkMcpHealth();
  if (!health.ok) {
    log.error(`MCP endpoint ${MCP_ENDPOINT} is not answering: ${health.error}`);
    return symbols.map((symbol) => ({
      symbol,
      ok: false,
      error: `MCP endpoint ${MCP_ENDPOINT} unreachable: ${health.error}`,
    }));
  }

  const dumps = await mapWithConcurrency(symbols, MCP_CONCURRENCY, (symbol) =>
    dumpSymbol(symbol, { deadlineAt })
  );

  const pending = dumps.filter((dump) => dump.pending || dump.data?.counts.pending).length;
  if (pending > 0) {
    log.warn(
      `run deadline reached — ${pending} symbol(s) left partial or undumped. ` +
        `Raise RUN_DEADLINE_MS, or find out why the MCP server is slow.`
    );
  }
  return dumps;
}
