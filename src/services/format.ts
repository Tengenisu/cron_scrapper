/** Small formatting helpers shared by the parsers, the store and the CLI. */

/** "1,615.50" -> 1615.5; "-", "--", "" and anything unparseable -> null. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (text === "" || text === "-" || text === "--") return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function truncate(text: string, limit = 2_000): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

/** 2026-09-04T09:45:12.123Z -> 20260904T094512Z — safe as a Windows filename. */
export function fileTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** ISO 8601 with the local UTC offset, e.g. 2026-09-04T09:45:00+05:30. */
export function localIsoTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset =
    offsetMinutes === 0 ? "Z" : `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return `${local.toISOString().slice(0, 23)}${offset}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Runs `worker` over `items`, at most `limit` at a time, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] as T;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
