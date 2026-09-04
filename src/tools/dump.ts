import { callTool } from "../services/mcp.js";
import { markdownToDocument } from "../services/markdown.js";
import { formatDuration, truncate } from "../services/format.js";
import { log } from "../services/log.js";
import { buildJobCatalog } from "./catalog.js";
import type { McpDump, McpJobResult, McpJobSpec, SymbolDump } from "../types.js";

/**
 * Runs the job catalogue for one symbol and shapes each answer into JSON.
 *
 * A tool that legitimately has nothing to say ("no corporate actions", "not
 * enough price history for a 200-day EMA") is marked `empty`, not failed — only
 * a transport/RPC/tool error sets `ok: false`, and even that doesn't fail the
 * symbol: the dump is always returned with per-job status so a partial answer is
 * still usable downstream.
 */

const EMPTY_MARKERS = [
  "No corporate actions found",
  "No recent announcements found",
  "Not enough price history",
  "No data",
  "_No rows returned._",
];

function isEmptyAnswer(text: string): boolean {
  const head = text.trimStart();
  if (!head) return true;
  return EMPTY_MARKERS.some((marker) => head.startsWith(marker));
}

async function runJob(spec: McpJobSpec): Promise<McpJobResult> {
  const call = await callTool(spec.tool, spec.args);

  const base = {
    label: spec.label,
    tool: spec.tool,
    raw: call.text,
    durationMs: call.durationMs,
  };

  if (!call.ok) {
    log.debug(`  ${spec.label}: ${call.error}`);
    return { ...base, ok: false, error: call.error, empty: false };
  }

  if (isEmptyAnswer(call.text)) {
    return { ...base, ok: true, error: null, empty: true };
  }

  const job: McpJobResult = { ...base, ok: true, error: null, empty: false };

  // JSON answers are kept as data; everything else is structured Markdown.
  const head = call.text.trimStart();
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      job.data = JSON.parse(head);
    } catch {
      job.content = markdownToDocument(call.text);
    }
  } else {
    job.content = markdownToDocument(call.text);
  }

  if (call.structured !== undefined && job.data === undefined) job.data = call.structured;
  return job;
}

function pendingJob(spec: McpJobSpec): McpJobResult {
  return {
    label: spec.label,
    tool: spec.tool,
    ok: true,
    error: null,
    empty: true,
    pending: true,
    raw: "",
    durationMs: 0,
  };
}

/**
 * Dumps one NSE symbol: every catalogue job, in order, against the MCP server.
 *
 * `deadlineAt` is a wall-clock cutoff for the whole pass. Once it passes, the
 * remaining jobs are marked `pending` instead of being fired, so a slow MCP
 * server degrades into a partial dump rather than an endless run.
 */
export async function dumpSymbol(
  symbol: string,
  options: { consolidated?: boolean; limit?: number; deadlineAt?: number } = {}
): Promise<SymbolDump> {
  const jobs = buildJobCatalog(symbol, options);
  const startedAt = Date.now();
  const deadlineAt = options.deadlineAt ?? Infinity;
  log.info(`MCP dump ${symbol} (${jobs.length} calls)`);

  const results: McpJobResult[] = [];
  for (const spec of jobs) {
    results.push(Date.now() >= deadlineAt ? pendingJob(spec) : await runJob(spec));
  }

  const counts = {
    total: results.length,
    ok: results.filter((job) => job.ok && !job.pending).length,
    failed: results.filter((job) => !job.ok).length,
    empty: results.filter((job) => job.empty && !job.pending).length,
    pending: results.filter((job) => job.pending).length,
  };

  const dump: McpDump = {
    symbol,
    generatedAt: new Date().toISOString(),
    counts,
    jobs: results,
  };

  log.info(
    `MCP dump ${symbol} done in ${formatDuration(Date.now() - startedAt)} ` +
      `(ok ${counts.ok}, failed ${counts.failed}, empty ${counts.empty}` +
      `${counts.pending ? `, pending ${counts.pending}` : ""})`
  );

  if (counts.pending === counts.total) {
    return { symbol, ok: false, pending: true, error: "run deadline reached before this symbol was dumped", data: dump };
  }

  if (counts.failed === counts.total) {
    const first = results[0];
    return {
      symbol,
      ok: false,
      error: truncate(first?.error ?? "every MCP call failed", 500),
      data: dump,
    };
  }

  return { symbol, ok: true, data: dump };
}
