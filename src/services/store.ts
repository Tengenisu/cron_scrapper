import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, KEEP_RUNS } from "../constants.js";
import { errorMessage } from "./format.js";
import { log } from "./log.js";
import type { EarningsSnapshot, StockResult, WrittenFiles } from "../types.js";

/**
 * Where a run's data actually lands.
 *
 * Every tick regenerates the whole tree — that is the point of the cron:
 *
 *   data/latest.json                  the newest snapshot (what n8n reads)
 *   data/runs/earnings-<stamp>.json   one file per run, pruned to KEEP_RUNS
 *   data/symbols/<SYMBOL>.json        the newest formatted result per symbol
 *   data/history.jsonl                one summary line per run, appended
 */

const RUN_FILE = /^earnings-.*\.json$/;

/** A BSE code is digits and an NSE symbol can carry &, - or spaces — keep it a filename. */
function symbolFile(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file); // atomic-ish: a reader never sees a half-written file
}

export function writeSnapshot(snapshot: EarningsSnapshot, dataDir: string = DATA_DIR): WrittenFiles {
  const runFile = path.join(dataDir, "runs", `earnings-${snapshot.runId}.json`);
  const latestFile = path.join(dataDir, "latest.json");
  const historyFile = path.join(dataDir, "history.jsonl");

  const dumped = snapshot.results.filter(
    (result): result is StockResult & { symbol: string } => Boolean(result.symbol && result.data)
  );
  const symbolFiles = dumped.map((result) => path.join(dataDir, "symbols", `${symbolFile(result.symbol)}.json`));

  // Attach the manifest before writing, so the document on disk and the one on
  // stdout are byte-for-byte the same.
  const files: WrittenFiles = { latest: latestFile, run: runFile, history: historyFile, symbols: symbolFiles };
  snapshot.files = files;

  writeJson(runFile, snapshot);
  writeJson(latestFile, snapshot);

  for (const result of dumped) {
    writeJson(path.join(dataDir, "symbols", `${symbolFile(result.symbol)}.json`), result);
  }

  appendHistory(historyFile, snapshot);
  pruneRuns(path.join(dataDir, "runs"));

  log.info(`wrote ${latestFile} (+ ${symbolFiles.length} symbol file(s))`);
  return files;
}

function appendHistory(file: string, snapshot: EarningsSnapshot): void {
  const line = {
    runId: snapshot.runId,
    scrapedAt: snapshot.scrapedAt,
    durationMs: snapshot.durationMs,
    counts: snapshot.counts,
    symbols: snapshot.results
      .filter((result) => result.symbol)
      .map((result) => `${result.symbol}:${result.exchange}`),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, "utf8");
  } catch (err) {
    log.warn(`could not append history: ${errorMessage(err)}`);
  }
}

/** Keeps the newest KEEP_RUNS snapshots so a 5-minute cadence can't fill the disk. */
function pruneRuns(runsDir: string): void {
  if (KEEP_RUNS <= 0) return;
  try {
    const files = fs
      .readdirSync(runsDir)
      .filter((name) => RUN_FILE.test(name))
      .sort(); // the timestamped names sort chronologically
    for (const name of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) {
      fs.unlinkSync(path.join(runsDir, name));
    }
  } catch (err) {
    log.warn(`could not prune ${runsDir}: ${errorMessage(err)}`);
  }
}

/** Reads back the newest snapshot, if any — handy for n8n and for debugging. */
export function readLatest(dataDir: string = DATA_DIR): EarningsSnapshot | null {
  const file = path.join(dataDir, "latest.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as EarningsSnapshot;
  } catch {
    return null;
  }
}
