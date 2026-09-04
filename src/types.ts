/**
 * This repo's job is narrow: find which stocks have results, resolve each one to
 * a tradeable symbol, hand that symbol to the screener MCP server, and format
 * what comes back.
 *
 * Nothing Moneycontrol itself reports about a company — price, market cap, its
 * own revenue/profit table — reaches the output. Moneycontrol is used as the
 * *scan*: which stocks, and what their symbol is. Every number in a snapshot
 * comes from the MCP server.
 */

export type Exchange = "NSE" | "BSE";

/** Why a stock turned up in the scan. */
export type EarningsEvent = "upcoming" | "reported";

/** One company off the earnings page, reduced to the only things we need. */
export interface ScrapedRow {
  company: string | null;
  scId: string | null; // Moneycontrol id, e.g. "DTL03" — the resolver's input
  /** Moneycontrol's group code: "N" | "B". A hint, not the answer. */
  exchange: string | null;
  /** Both, when a company shows up in the calendar and in rapid results. */
  events: EarningsEvent[];
}

export type SectionSelection = "both" | "calendar" | "rapid";

/** What the price feed resolved an scId to. */
export interface ResolvedSymbol {
  symbol: string; // "DHOOTTRANS" on the NSE, the scrip code "541735" on the BSE
  exchange: Exchange;
}

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
// The MCP dump — the raw, per-call layer
// --------------------------------------------------------------------------- //

/** One entry of the per-symbol job catalogue: slot + label + tool + arguments. */
export interface McpJobSpec {
  /** Where this call's answer lands in the formatted document. */
  slot: string;
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
  slot: string;
  label: string;
  tool: string;
  ok: boolean;
  error: string | null;
  empty: boolean;
  /** Never called: the run deadline was reached before this job's turn. */
  pending?: boolean;
  data?: unknown;
  content?: MarkdownDocument;
  raw: string;
  durationMs: number;
}

export interface McpCounts {
  total: number;
  ok: number;
  failed: number;
  empty: number;
  pending: number;
}

export interface McpDump {
  symbol: string;
  exchange: Exchange;
  generatedAt: string;
  counts: McpCounts;
  jobs: McpJobResult[];
}

// --------------------------------------------------------------------------- //
// The formatted MCP document — what actually ships
// --------------------------------------------------------------------------- //

/** screener_get_company_overview, reshaped. */
export interface CompanyProfile {
  name: string | null;
  screenerUrl: string | null;
  about: string | null;
  /** topRatios flattened to name -> value ("Stock P/E": "22.6"). */
  ratios: Record<string, string>;
  pros: string[];
  cons: string[];
}

/** One screener_get_financial_statement answer. */
export interface FinancialStatement {
  section: string | null;
  periods: string[];
  /** Line item -> one value per period, aligned with `periods`. */
  rows: Record<string, (string | number | null)[]>;
}

export interface Financials {
  quarters: FinancialStatement | null;
  profitAndLoss: FinancialStatement | null;
  balanceSheet: FinancialStatement | null;
  cashFlow: FinancialStatement | null;
  ratios: FinancialStatement | null;
}

/** One technical_get_indicator answer, newest point first. */
export interface Indicator {
  indicator: string | null;
  interval: string | null;
  timePeriod: number | null;
  /** The newest reading, e.g. {"RSI": "75.48"}. */
  latest: Record<string, string | number | null> | null;
  points: { date: string | null; values: Record<string, string | number | null> }[];
}

export interface SearchMatch {
  id: string | null;
  name: string | null;
  url: string | null;
}

/** A call that failed or was never made, kept so a gap is never silent. */
export interface JobIssue {
  slot: string;
  label: string;
  tool: string;
  reason: "failed" | "pending";
  error: string | null;
}

/** Everything the MCP server had to say about one symbol, formatted. */
export interface StockData {
  generatedAt: string;
  profile: CompanyProfile | null;
  financials: Financials;
  peers: unknown | null;
  quote: Record<string, unknown> | null;
  announcements: unknown[];
  corporateActions: unknown[];
  /** Keyed by slot: "RSI14", "SMA50", "EMA200", "MACD". */
  technicals: Record<string, Indicator>;
  matches: SearchMatch[];
  counts: McpCounts;
  issues: JobIssue[];
}

// --------------------------------------------------------------------------- //
// The document this whole thing exists to produce
// --------------------------------------------------------------------------- //

export type StockStatus =
  /** Dumped from the MCP server. */
  | "ok"
  /** Every MCP call for this symbol failed. */
  | "failed"
  /** The run deadline arrived first; the next tick picks it up. */
  | "pending"
  /** The price feed had no NSE symbol and no BSE code — nothing to look up. */
  | "unresolved";

/** One stock: who it is, and what the MCP server returned for it. */
export interface StockResult {
  company: string | null;
  scId: string | null;
  symbol: string | null;
  exchange: Exchange | null;
  events: EarningsEvent[];
  status: StockStatus;
  error: string | null;
  data: StockData | null;
}

export interface SnapshotCounts {
  scanned: number;
  resolved: number;
  unresolved: number;
  ok: number;
  failed: number;
  pending: number;
}

export interface EarningsSnapshot {
  ok: true;
  runId: string;
  source: string;
  cacheEnabled: boolean;
  scrapedAt: string;
  durationMs: number;
  counts: SnapshotCounts;
  /** True when the run deadline cut the MCP step short. */
  truncated: boolean;
  results: StockResult[];
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
