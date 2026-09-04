/** A company about to report — one row of Moneycontrol's RESULT CALENDAR. */
export interface CalendarEntry {
  date: string | null; // "4 Sep"
  company: string | null;
  shortName: string | null;
  scId: string | null; // Moneycontrol id, e.g. "DTL03"
  exchange: string | null; // "N" | "B"
  resultType: string | null; // "Q1 FY26-27"
  ltp: number | null;
  changePercent: number | null;
  time: string | null;
  marketCap: number | null;
  url: string | null;
  financialsUrl: string | null;
  nseSymbol: string | null; // filled in by the symbol resolver
}

/** One metric row inside a rapid result: Revenue / Gross Profit / Net Profit. */
export interface QuarterMetric {
  metric: string | null;
  current: number | null;
  previous: number | null;
  growthPercent: number | null;
}

/** A company that has just reported — one row of Moneycontrol's RAPID RESULTS. */
export interface RapidResult {
  date: string | null; // "September 02, 2026"
  company: string | null;
  scId: string | null;
  exchange: string | null;
  ltp: number | null;
  changePercent: number | null;
  financialType: string | null; // "Consolidated" | "Standalone"
  period: string | null; // "Q1 FY26-27"
  columns: string[];
  quarterData: QuarterMetric[];
  url: string | null;
  nseSymbol: string | null;
}

/** The two sections, as they come out of the page's __NEXT_DATA__ blob. */
export interface EarningsSections {
  calendarDate: string | null;
  calendarRange: { from: string | null; to: string | null };
  resultCalendar: CalendarEntry[];
  rapidResults: RapidResult[];
}

export type SectionSelection = "both" | "calendar" | "rapid";

// --------------------------------------------------------------------------- //
// Markdown parsed out of an MCP tool's text content
// --------------------------------------------------------------------------- //

export type MarkdownValue = string | number | boolean | null;
export type MarkdownRow = Record<string, MarkdownValue>;

export interface MarkdownBlock {
  lang: string;
  content: string;
  data?: unknown; // set when the fenced block parsed as JSON
}

export interface MarkdownSection {
  title: string | null;
  level: number;
  tables: MarkdownRow[][];
  fields: Record<string, MarkdownValue>;
  items: string[];
  blocks: MarkdownBlock[];
  text: string;
}

export interface MarkdownDocument {
  sections: MarkdownSection[];
  fields: Record<string, MarkdownValue>; // merged from every section
  tables: MarkdownRow[][]; // every table, flattened
  raw: string;
}

// --------------------------------------------------------------------------- //
// The MCP dump
// --------------------------------------------------------------------------- //

/** One entry of the per-symbol job catalogue: label + tool + arguments. */
export interface McpJobSpec {
  label: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * One executed job. `data` holds parsed JSON when the tool returned JSON,
 * `content` holds the structured Markdown otherwise, and `raw` always keeps the
 * original text so nothing is lost if the shape changes upstream.
 *
 * `ok: false` marks a real tool error; `empty: true` marks a legitimate
 * "no data" answer (no corporate actions, not enough history for a 200-day EMA)
 * — neither fails the run.
 */
export interface McpJobResult {
  label: string;
  tool: string;
  ok: boolean;
  error: string | null;
  empty: boolean;
  data?: unknown;
  content?: MarkdownDocument;
  raw: string;
  durationMs: number;
}

export interface McpDump {
  symbol: string;
  generatedAt: string;
  counts: { total: number; ok: number; failed: number; empty: number };
  jobs: McpJobResult[];
}

/** What lands in snapshot.mcp[] — one element per resolved NSE symbol. */
export interface SymbolDump {
  symbol: string;
  ok: boolean;
  error?: string;
  data?: McpDump;
}

// --------------------------------------------------------------------------- //
// The document this whole thing exists to produce
// --------------------------------------------------------------------------- //

export interface EarningsSnapshot {
  ok: true;
  runId: string;
  source: string;
  cacheEnabled: boolean;
  scrapedAt: string;
  durationMs: number;
  calendarDate: string | null;
  calendarRange: { from: string | null; to: string | null };
  resultCalendar: CalendarEntry[];
  rapidResults: RapidResult[];
  nseSymbols: string[];
  counts: {
    resultCalendar: number;
    rapidResults: number;
    nseSymbols: number;
    mcpOk: number;
    mcpFailed: number;
  };
  mcp: SymbolDump[];
  files?: WrittenFiles;
}

export interface WrittenFiles {
  latest: string;
  run: string;
  history: string;
  symbols: string[];
}

/** A tick that landed while the previous pass was still running. Not an error. */
export interface SkippedRun {
  ok: true;
  skipped: true;
  reason: string;
}

/** Any failure, reported as a parseable document so n8n never sees empty stdout. */
export interface FailedRun {
  ok: false;
  error: string;
}

export type RunResult = EarningsSnapshot | SkippedRun | FailedRun;
