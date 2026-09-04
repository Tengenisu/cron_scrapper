import cron from "node-cron";
import { CRON_SCHEDULE, CRON_TIMEZONE, RUN_ON_START } from "../constants.js";
import { errorMessage, formatDuration } from "./format.js";
import { log } from "./log.js";

/**
 * The in-process schedule.
 *
 * cron(8) exists only on POSIX hosts, and this has to run on Windows too, so the
 * cadence lives here as a real cron expression (every 5 minutes in testing mode)
 * driven by node-cron. crontab.txt carries the same schedule for a host that
 * would rather own it — run one or the other, never both, or every symbol gets
 * queried twice.
 *
 * Ticks never overlap: a tick that fires while the previous pass is still
 * running is dropped here, and the file lock in the pipeline catches the
 * cross-process case (cron + n8n on the same checkout).
 */
export interface SchedulerHandle {
  stop: () => Promise<void>;
}

export function startScheduler(task: () => Promise<void>): SchedulerHandle {
  if (!cron.validate(CRON_SCHEDULE)) {
    throw new Error(`CRON_SCHEDULE="${CRON_SCHEDULE}" is not a valid cron expression.`);
  }

  let running = false;
  let ticks = 0;

  const tick = async (trigger: string) => {
    if (running) {
      log.warn(`${trigger}: previous pass still running — skipping this tick`);
      return;
    }
    running = true;
    const startedAt = Date.now();
    ticks++;
    log.info(`--- tick #${ticks} (${trigger}) ---`);
    try {
      await task();
    } catch (err) {
      log.error(`tick #${ticks} threw: ${errorMessage(err)}`);
    } finally {
      running = false;
      log.info(`tick #${ticks} took ${formatDuration(Date.now() - startedAt)}`);
    }
  };

  const job = cron.schedule(CRON_SCHEDULE, () => void tick("cron"), {
    scheduled: true,
    timezone: CRON_TIMEZONE,
  });

  log.info(`scheduler started: "${CRON_SCHEDULE}" (${CRON_TIMEZONE})`);
  if (RUN_ON_START) void tick("startup");

  const stop = async () => {
    job.stop();
    // Let an in-flight pass finish so it never leaves a half-written data file.
    while (running) await new Promise((resolve) => setTimeout(resolve, 250));
    log.info("scheduler stopped");
  };

  return { stop };
}
