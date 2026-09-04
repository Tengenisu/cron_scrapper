import fs from "node:fs";
import { LOCK_FILE, LOCK_STALE_MS } from "../constants.js";
import { errorMessage, formatDuration } from "./format.js";
import { log } from "./log.js";

/**
 * Best-effort single-run lock built on an exclusive create (`wx`), so ticks from
 * cron, `npm run cron` and n8n can never overlap on the same checkout.
 *
 * A lock is only worth anything if it is guaranteed to go away again, and a run
 * can die three ways: cleanly (the `finally` in the pipeline), by signal (an n8n
 * execution cancelled, `timeout` firing, the container stopping), or hard
 * (SIGKILL, a crash). So:
 *
 *   - the file records the owning pid, and a lock whose pid is no longer alive
 *     is stolen immediately rather than blocking every tick until it ages out;
 *   - acquiring installs process handlers that remove the file on exit and on
 *     SIGINT/SIGTERM/SIGBREAK;
 *   - a lock older than `staleAfterMs` is stolen regardless, which covers the
 *     one case the pid check cannot — an unrelated process reusing that pid.
 *
 * Passing an empty path disables the whole mechanism (`--no-lock`).
 */

const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGBREAK"] as const;

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unreadable: assume held
  try {
    process.kill(pid, 0); // signal 0 tests for existence, sends nothing
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RunLock {
  private held = false;
  private cleanup: (() => void) | null = null;

  constructor(
    private readonly path: string = LOCK_FILE,
    private readonly staleAfterMs: number = LOCK_STALE_MS
  ) {}

  acquire(): boolean {
    if (!this.path) return true;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(this.path, `${process.pid} ${Date.now()}`, { flag: "wx" });
        this.held = true;
        this.installCleanup();
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          log.warn(`cannot create lock ${this.path}: ${errorMessage(err)} — running unlocked`);
          return true;
        }
        if (!this.stealIfDead()) return false;
      }
    }
    return false;
  }

  /** Returns true when the existing lock was removed and the create is worth retrying. */
  private stealIfDead(): boolean {
    let contents = "";
    try {
      contents = fs.readFileSync(this.path, "utf8");
    } catch {
      return true; // vanished between calls — retry the create
    }

    const [pidText, stampText] = contents.trim().split(/\s+/);
    const pid = Number(pidText);
    const writtenAt = Number(stampText);
    const age = Number.isFinite(writtenAt) ? Date.now() - writtenAt : Infinity;

    if (isAlive(pid)) {
      if (age < this.staleAfterMs) return false; // a real run is in flight
      log.warn(`stealing lock ${this.path} from pid ${pid} — ${formatDuration(age)} old`);
    } else {
      log.warn(`stealing orphaned lock ${this.path} — pid ${pid} is gone (killed run?)`);
    }

    try {
      fs.unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }

  private installCleanup(): void {
    const remove = () => {
      try {
        fs.unlinkSync(this.path);
      } catch {
        // already gone, or someone stole it — nothing to do
      }
    };

    // A killed run must not leave the lock behind: every later tick would skip
    // until it aged out, which looks exactly like a scraper that never runs.
    const onSignal = (signal: NodeJS.Signals) => {
      remove();
      process.exit(signal === "SIGINT" ? 130 : 143);
    };

    process.once("exit", remove);
    for (const signal of EXIT_SIGNALS) process.once(signal, onSignal);

    this.cleanup = () => {
      process.removeListener("exit", remove);
      for (const signal of EXIT_SIGNALS) process.removeListener(signal, onSignal);
    };
  }

  release(): void {
    if (!this.held) return;
    try {
      fs.unlinkSync(this.path);
    } catch (err) {
      log.warn(`could not remove lock ${this.path}: ${errorMessage(err)}`);
    }
    this.cleanup?.();
    this.cleanup = null;
    this.held = false;
  }
}
