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
import { scanEarnings } from "./services/moneycontrol.js";
import { SymbolResolver } from "./services/symbols.js";
import { writeSnapshot } from "./services/store.js";
import { errorMessage, fileTimestamp, formatDuration, localIsoTimestamp, mapWithConcurrency } from "./services/format.js";
import { log } from "./services/log.js";
import { dumpSymbol, firstError } from "./tools/dump.js";
import { formatDump } from "./tools/format.js";
import type { CliOptions } from "./schemas/index.js";
import type { EarningsSnapshot, ResolvedSymbol, RunResult, ScrapedRow, StockResult } from "./types.js";

/**
 * One full pass: lock → scan the earnings page for stocks → resolve each to an
 * NSE symbol or BSE code → dump that symbol from the MCP server → format what
 * came back → write it.
 *
 * The scan is the only thing Moneycontrol is used for. Nothing it reports about
 * a company — price, market cap, its own results table — is carried into the
 * output: every figure in a snapshot came from the MCP server.
 *
 * No dedup is done across runs. Every run emits the current full scan and n8n
 * decides what is new.
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
    const { counts } = snapshot;
    log.info(
      `run ${snapshot.runId} finished in ${formatDuration(snapshot.durationMs)} — ` +
        `${counts.scanned} stock(s), ${counts.ok} dumped, ${counts.failed} failed, ` +
        `${counts.unresolved} unresolved` +
        `${snapshot.truncated ? `, ${counts.pending} pending (deadline)` : ""}`
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

/** A scanned row plus whatever the price feed made of it. */
interface Candidate {
  row: ScrapedRow;
  resolved: ResolvedSymbol | null;
}

async function collect(
  options: Pick<CliOptions, "section" | "enrich">,
  startedAt: number
): Promise<EarningsSnapshot> {
  const rows = await scanEarnings(options.section);

  const resolver = new SymbolResolver();
  const candidates: Candidate[] = [];
  for (const row of rows) {
    candidates.push({ row, resolved: await resolver.resolve(row.scId, row.exchange) });
  }
  resolver.save();

  const resolved = candidates.filter((candidate) => candidate.resolved !== null);
  log.info(
    `resolved ${resolved.length}/${candidates.length} stock(s): ` +
      (resolved.map((c) => `${c.resolved!.symbol}[${c.resolved!.exchange}]`).join(", ") || "—")
  );

  // Everything above is cheap; the MCP step is what can drag, so the deadline is
  // measured from the start of the run and only ever cuts that step short.
  const deadlineAt = RUN_DEADLINE_MS > 0 ? startedAt + RUN_DEADLINE_MS : Infinity;
  const results = options.enrich
    ? await dumpAll(candidates, deadlineAt)
    : candidates.map((candidate) => toResult(candidate));

  const counts = {
    scanned: results.length,
    resolved: resolved.length,
    unresolved: results.filter((result) => result.status === "unresolved").length,
    ok: results.filter((result) => result.status === "ok").length,
    failed: results.filter((result) => result.status === "failed").length,
    pending: results.filter((result) => result.status === "pending").length,
  };

  return {
    ok: true,
    runId: fileTimestamp(new Date(startedAt)),
    source: EARNINGS_URL,
    cacheEnabled: CACHE_ENABLED,
    scrapedAt: localIsoTimestamp(),
    durationMs: Date.now() - startedAt,
    counts,
    truncated: results.some(
      (result) => result.status === "pending" || (result.data?.counts.pending ?? 0) > 0
    ),
    results,
  };
}

/** The identity half of a result — everything before the MCP server is asked. */
function toResult(candidate: Candidate, overrides: Partial<StockResult> = {}): StockResult {
  const { row, resolved } = candidate;
  return {
    company: row.company,
    scId: row.scId,
    symbol: resolved?.symbol ?? null,
    exchange: resolved?.exchange ?? null,
    events: row.events,
    status: resolved ? "ok" : "unresolved",
    error: resolved ? null : "no NSE symbol or BSE code for this scId",
    data: null,
    ...overrides,
  };
}

async function dumpAll(candidates: Candidate[], deadlineAt: number): Promise<StockResult[]> {
  const dumpable = candidates.filter((candidate) => candidate.resolved !== null);
  if (dumpable.length === 0) return candidates.map((candidate) => toResult(candidate));

  // One probe up front: a dead endpoint is worth reporting once, not as the same
  // connection error repeated for every call of every symbol.
  const health = await checkMcpHealth();
  if (!health.ok) {
    log.error(`MCP endpoint ${MCP_ENDPOINT} is not answering: ${health.error}`);
    const error = `MCP endpoint ${MCP_ENDPOINT} unreachable: ${health.error}`;
    return candidates.map((candidate) =>
      candidate.resolved ? toResult(candidate, { status: "failed", error }) : toResult(candidate)
    );
  }

  const dumped = new Map<Candidate, StockResult>();
  await mapWithConcurrency(dumpable, MCP_CONCURRENCY, async (candidate) => {
    const { symbol, exchange } = candidate.resolved!;
    const dump = await dumpSymbol(symbol, exchange, { deadlineAt });
    const data = formatDump(dump);

    // Never called at all: the deadline arrived first. Not a failure — the next
    // tick picks it up, and the snapshot is marked truncated.
    if (dump.counts.pending === dump.counts.total) {
      dumped.set(
        candidate,
        toResult(candidate, {
          status: "pending",
          error: "run deadline reached before this stock was dumped",
          data,
        })
      );
      return;
    }

    dumped.set(
      candidate,
      toResult(candidate, {
        status: dump.counts.failed === dump.counts.total ? "failed" : "ok",
        error: dump.counts.failed === dump.counts.total ? firstError(dump) : null,
        data,
      })
    );
  });

  // Rebuilt in scan order: concurrency decides finish order, and a snapshot that
  // reshuffles its own rows between runs is a nuisance to diff.
  const results = candidates.map((candidate) => dumped.get(candidate) ?? toResult(candidate));

  const pending = results.filter(
    (result) => result.status === "pending" || (result.data?.counts.pending ?? 0) > 0
  ).length;
  if (pending > 0) {
    log.warn(
      `run deadline reached — ${pending} stock(s) left partial or undumped. ` +
        `Raise RUN_DEADLINE_MS, or find out why the MCP server is slow.`
    );
  }
  return results;
}
