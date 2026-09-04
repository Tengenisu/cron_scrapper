import type {
  CompanyProfile,
  Financials,
  FinancialStatement,
  Indicator,
  JobIssue,
  McpDump,
  McpJobResult,
  SearchMatch,
  StockData,
} from "../types.js";

/**
 * The formatting step: raw MCP answers in, one clean document out.
 *
 * The dump layer keeps every call verbatim — status, timing, the tool's own
 * text — because that is what you need when something breaks. None of that is
 * what a consumer wants, and `raw` alone is what made a snapshot megabytes. This
 * reads each job's `slot` (set by the catalogue) and lands its payload where it
 * belongs, dropping the per-call bookkeeping and keeping only what didn't work
 * under `issues`, so a missing section is never silently indistinguishable from
 * a section that genuinely has no data.
 */

type Cell = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function cell(value: unknown): Cell {
  if (typeof value === "number") return value;
  const asText = text(value);
  return asText;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((item): item is string => item !== null) : [];
}

/** The job's payload: parsed JSON when there was any, the Markdown doc otherwise. */
function payload(job: McpJobResult): unknown {
  if (job.data !== undefined) return job.data;
  return job.content ?? null;
}

function formatProfile(job: McpJobResult): CompanyProfile | null {
  const data = payload(job);
  if (!isRecord(data)) return null;

  // topRatios arrives as [{name, value}] — a list to iterate is the wrong shape
  // for "what is its P/E", so it is flattened to a lookup.
  const ratios: Record<string, string> = {};
  if (Array.isArray(data["topRatios"])) {
    for (const entry of data["topRatios"]) {
      if (!isRecord(entry)) continue;
      const name = text(entry["name"]);
      const value = text(entry["value"]);
      if (name) ratios[name] = value ?? "";
    }
  }

  return {
    name: text(data["name"]),
    screenerUrl: text(data["screenerUrl"]),
    about: text(data["aboutText"]),
    ratios,
    pros: stringList(data["pros"]),
    cons: stringList(data["cons"]),
  };
}

function formatStatement(job: McpJobResult): FinancialStatement | null {
  const data = payload(job);
  if (!isRecord(data)) return null;

  const periods = stringList(data["periods"]);
  // {label, values[]} rows become label -> values, so a line item is addressable
  // by name; `periods` stays alongside as the column key for the value array.
  const rows: Record<string, Cell[]> = {};
  if (Array.isArray(data["rows"])) {
    for (const row of data["rows"]) {
      if (!isRecord(row)) continue;
      const label = text(row["label"]);
      if (!label) continue;
      rows[label] = Array.isArray(row["values"]) ? row["values"].map(cell) : [];
    }
  }

  return { section: text(data["section"]), periods, rows };
}

/** "RSI14" -> 14, "EMA200" -> 200, "MACD" -> null (it is fixed at 12/26/9). */
function periodFromSlot(key: string): number | null {
  const digits = /(\d+)$/.exec(key);
  return digits ? Number(digits[1]) : null;
}

function formatIndicator(job: McpJobResult, key: string): Indicator | null {
  const data = payload(job);
  if (!isRecord(data)) return null;

  const points = (Array.isArray(data["points"]) ? data["points"] : [])
    .filter(isRecord)
    .map((point) => {
      const values: Record<string, Cell> = {};
      if (isRecord(point["values"])) {
        for (const [key, value] of Object.entries(point["values"])) values[key] = cell(value);
      }
      return { date: text(point["date"]), values };
    });

  return {
    indicator: text(data["indicator"]),
    interval: text(data["interval"]),
    timePeriod: periodFromSlot(key),
    // The server returns newest first, so points[0] is the reading you want.
    latest: points[0]?.values ?? null,
    points,
  };
}

function formatMatches(job: McpJobResult): SearchMatch[] {
  const data = payload(job);
  const results = isRecord(data) && Array.isArray(data["results"]) ? data["results"] : [];
  return results.filter(isRecord).map((match) => ({
    id: text(match["id"]),
    name: text(match["name"]),
    url: text(match["url"]),
  }));
}

/** nse_get_announcements / nse_get_corporate_actions both answer {results: [...]}. */
function formatList(job: McpJobResult): unknown[] {
  const data = payload(job);
  if (Array.isArray(data)) return data;
  if (isRecord(data) && Array.isArray(data["results"])) return data["results"];
  return [];
}

function emptyFinancials(): Financials {
  return { quarters: null, profitAndLoss: null, balanceSheet: null, cashFlow: null, ratios: null };
}

/**
 * One dump -> one formatted document.
 *
 * A job that failed, was never run, or legitimately had nothing to say leaves
 * its slot at its empty value (null, [], absent) and — for the first two — adds
 * an entry to `issues`. "No corporate actions" and "the call errored" must not
 * look the same downstream.
 */
export function formatDump(dump: McpDump): StockData {
  const data: StockData = {
    generatedAt: dump.generatedAt,
    profile: null,
    financials: emptyFinancials(),
    peers: null,
    quote: null,
    announcements: [],
    corporateActions: [],
    technicals: {},
    matches: [],
    counts: dump.counts,
    issues: [],
  };

  for (const job of dump.jobs) {
    if (job.pending || !job.ok) {
      data.issues.push({
        slot: job.slot,
        label: job.label,
        tool: job.tool,
        reason: job.pending ? "pending" : "failed",
        error: job.error,
      });
      continue;
    }
    if (job.empty) continue; // a real "no data" answer — the slot's empty value says it

    if (job.slot.startsWith("financials.")) {
      const key = job.slot.slice("financials.".length) as keyof Financials;
      data.financials[key] = formatStatement(job);
      continue;
    }
    if (job.slot.startsWith("technicals.")) {
      const key = job.slot.slice("technicals.".length);
      const indicator = formatIndicator(job, key);
      if (indicator) data.technicals[key] = indicator;
      continue;
    }

    switch (job.slot) {
      case "profile":
        data.profile = formatProfile(job);
        break;
      case "matches":
        data.matches = formatMatches(job);
        break;
      case "peers":
        data.peers = payload(job);
        break;
      case "quote": {
        const quote = payload(job);
        data.quote = isRecord(quote) ? quote : null;
        break;
      }
      case "announcements":
        data.announcements = formatList(job);
        break;
      case "corporateActions":
        data.corporateActions = formatList(job);
        break;
      default:
        break;
    }
  }

  return data;
}
