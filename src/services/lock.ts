import fs from "node:fs";
import { LOCK_FILE, LOCK_STALE_MS } from "../constants.js";
import { errorMessage, formatDuration } from "./format.js";
import { log } from "./log.js";

/**
 * Best-effort single-run lock built on an exclusive create (`wx`), so ticks from
 * cron, `npm run cron` and n8n can never overlap on the same checkout.
 *
 * A lock older than `staleAfterMs` is assumed to belong to a crashed run and is
 * stolen; passing an empty path disables the whole mechanism (`--no-lock`).
 */
export class RunLock {
  private held = false;

  constructor(
    private readonly path: string = LOCK_FILE,
    private readonly staleAfterMs: number = LOCK_STALE_MS
  ) {}

  acquire(): boolean {
    if (!this.path) return true;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.path, `${process.pid} ${Date.now()}`, { flag: "wx" });
        this.held = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          log.warn(`cannot create lock ${this.path}: ${errorMessage(err)} — running unlocked`);
          return true;
        }
        if (!this.stealIfStale()) return false;
      }
    }
    return false;
  }

  private stealIfStale(): boolean {
    let age: number;
    try {
      age = Date.now() - fs.statSync(this.path).mtimeMs;
    } catch {
      return true; // vanished between calls — retry the create
    }
    if (age < this.staleAfterMs) return false;

    log.warn(`stealing stale lock ${this.path} (${formatDuration(age)} old)`);
    try {
      fs.unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (!this.held) return;
    try {
      fs.unlinkSync(this.path);
    } catch (err) {
      log.warn(`could not remove lock ${this.path}: ${errorMessage(err)}`);
    }
    this.held = false;
  }
}
