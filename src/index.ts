#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { CRON_SCHEDULE, CRON_TIMEZONE, DATA_DIR, MCP_ENDPOINT } from "./constants.js";
import { CliOptionsSchema, type CliOptions } from "./schemas/index.js";
import { log } from "./services/log.js";
import { startScheduler } from "./services/scheduler.js";
import { errorMessage } from "./services/format.js";
import { runOnce } from "./pipeline.js";
import type { RunResult } from "./types.js";

/**
 * Two modes, picked the same way screener-mcp-server picks its transport:
 *
 *   node dist/index.js            one pass, JSON on stdout   (cron / n8n call this)
 *   node dist/index.js --cron     stay up and run on a schedule
 *
 * stdout carries exactly one JSON document — a snapshot, `{"ok":true,"skipped":true}`
 * for an overlapping tick, or `{"ok":false,"error":"..."}` — so the n8n Execute
 * Command node always has something parseable. Logs go to stderr.
 */

const USAGE = `moneycontrol earnings scraper

Usage: node dist/index.js [options]

Modes:
  --once                 run one pass and print the JSON snapshot (default)
  --cron                 stay up and run on CRON_SCHEDULE (currently "${CRON_SCHEDULE}", ${CRON_TIMEZONE})

Options:
  --section <both|calendar|rapid>   which section(s) to scrape (default: both)
  --no-mcp                          skip the MCP dump step (scrape only)
  --pretty                          indent the JSON output
  --symbols-only                    print just the resolved NSE symbols, one per line
  --out <file>                      also write the JSON document to this file
  --no-lock                         run even if another pass is in flight
  --quiet                           don't print the document (data/ is still written)
  --print                           print every document in --cron mode (off by default:
                                    a snapshot is megabytes, and data/ already has it)
  -h, --help                        this text

Data is regenerated under ${DATA_DIR} on every run; MCP_ENDPOINT is ${MCP_ENDPOINT}.
Every constant in src/constants.ts is overridable by an env var of the same name.`;

export function parseArgs(argv: string[]): CliOptions {
  const raw: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--once":
        raw["mode"] = "once";
        break;
      case "--cron":
        raw["mode"] = "cron";
        break;
      case "--section": {
        const value = argv[++i];
        if (!value) throw new Error("--section needs a value (both|calendar|rapid)");
        raw["section"] = value;
        break;
      }
      case "--no-mcp":
      case "--no-node": // the Python CLI's name for the same thing
        raw["enrich"] = false;
        break;
      case "--pretty":
        raw["pretty"] = true;
        break;
      case "--symbols-only":
        raw["symbolsOnly"] = true;
        break;
      case "--no-lock":
        raw["useLock"] = false;
        break;
      case "--quiet":
        raw["quiet"] = true;
        break;
      case "--print":
        raw["print"] = true;
        break;
      case "--out": {
        const value = argv[++i];
        if (!value) throw new Error("--out needs a file path");
        raw["out"] = value;
        break;
      }
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option "${arg}" (try --help)`);
    }
  }

  const parsed = CliOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  return parsed.data;
}

function emit(result: RunResult, options: CliOptions): void {
  if (options.symbolsOnly) {
    if ("nseSymbols" in result) for (const symbol of result.nseSymbols) console.log(symbol);
    return;
  }

  const payload = JSON.stringify(result, null, options.pretty ? 2 : undefined);
  if (!options.quiet) console.log(payload);

  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, `${payload}\n`, "utf8");
    log.info(`wrote ${options.out}`);
  }
}

async function runOnceMode(options: CliOptions): Promise<number> {
  const result = await runOnce(options);
  emit(result, options);
  return result.ok ? 0 : 1;
}

async function runCronMode(options: CliOptions): Promise<number> {
  // A snapshot is megabytes of JSON and data/latest.json already holds it, so
  // the scheduler logs a summary line to stderr instead of flooding stdout on
  // every tick. --print (or --out) brings the document back.
  const tickOptions: CliOptions = { ...options, quiet: options.quiet || !options.print };

  const handle = startScheduler(async () => {
    const result = await runOnce(options);
    emit(result, tickOptions);
    if (!options.symbolsOnly && "counts" in result) {
      log.info(
        `snapshot ${result.runId}: ${result.counts.nseSymbols} symbol(s), ` +
          `${result.counts.mcpOk} dumped, ${result.counts.mcpFailed} failed, ` +
          `${result.counts.mcpPending} pending${result.truncated ? " (deadline)" : ""}`
      );
    }
  });

  // Keep the process alive until the platform (or Ctrl-C) stops it, and let an
  // in-flight pass finish so data/ is never left half-written.
  await new Promise<void>((resolve) => {
    let stopping = false;
    // SIGBREAK is the Windows console's stop signal; SIGTERM never fires there,
    // so a Windows host is stopped with Ctrl-C / Ctrl-Break or by killing the tree.
    const signals = process.platform === "win32"
      ? (["SIGINT", "SIGBREAK"] as const)
      : (["SIGINT", "SIGTERM"] as const);
    for (const signal of signals) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        log.info(`${signal} received — shutting down`);
        void handle.stop().then(resolve);
      });
    }
  });

  return 0;
}

async function main(): Promise<number> {
  // The MCP dump carries rupee signs and em dashes; never die on a cp1252 console.
  process.stdout.setDefaultEncoding("utf8");
  process.stderr.setDefaultEncoding("utf8");

  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${errorMessage(err)}\n\n${USAGE}`);
    return 2;
  }

  return options.mode === "cron" ? runCronMode(options) : runOnceMode(options);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Last resort: still emit a parseable document, never a bare stack trace.
    console.error(err);
    console.log(JSON.stringify({ ok: false, error: errorMessage(err) }));
    process.exit(1);
  });
