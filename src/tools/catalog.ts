import { MCP_CONSOLIDATED, MCP_LIST_LIMIT } from "../constants.js";
import type { Exchange, McpJobSpec } from "../types.js";

/**
 * The job catalogue: every MCP tool call fired for one stock.
 *
 * `slot` is the contract with the formatter — it is where the answer lands in
 * the finished document (`financials.quarters`, `technicals.RSI14`, …), so the
 * shape of a snapshot is decided here rather than by string-matching labels
 * downstream.
 *
 * The catalogue is exchange-aware. The screener tools take the symbol either way
 * (screener.in serves /company/DHOOTTRANS/ and /company/541735/ alike), but the
 * nse_* tools only mean anything for an NSE listing, and the indicators resolve
 * to a Yahoo ticker — TECHNOCRAF.NS, 541735.BO — so asking for a symbol on the
 * exchange it is not listed on returns nothing at best and the wrong company at
 * worst. A BSE-only stock therefore gets a shorter catalogue, not a broken one.
 */

/** [slot, statement] — the five screener financial statements, in reading order. */
const STATEMENTS: readonly [string, string][] = [
  ["quarters", "quarters"],
  ["profitAndLoss", "profit-loss"],
  ["balanceSheet", "balance-sheet"],
  ["cashFlow", "cash-flow"],
  ["ratios", "ratios"],
];

/** [slot, indicator, time_period] — MACD takes no period (it is fixed at 12/26/9). */
const INDICATORS: readonly [string, string, number | null][] = [
  ["RSI14", "RSI", 14],
  ["SMA50", "SMA", 50],
  ["EMA200", "EMA", 200],
  ["MACD", "MACD", null],
];

export function buildJobCatalog(
  symbol: string,
  exchange: Exchange,
  options: { consolidated?: boolean; limit?: number } = {}
): McpJobSpec[] {
  const consolidated = options.consolidated ?? MCP_CONSOLIDATED;
  const limit = options.limit ?? MCP_LIST_LIMIT;

  return [
    { slot: "matches", label: "SEARCH MATCH", tool: "screener_search_companies", args: { query: symbol } },
    {
      slot: "profile",
      label: "COMPANY OVERVIEW",
      tool: "screener_get_company_overview",
      args: { identifier: symbol, consolidated },
    },
    ...STATEMENTS.map(([slot, statement]) => ({
      slot: `financials.${slot}`,
      label: statement.toUpperCase(),
      tool: "screener_get_financial_statement",
      args: { identifier: symbol, statement, consolidated },
    })),
    {
      slot: "peers",
      label: "PEER COMPARISON",
      tool: "screener_get_peer_comparison",
      args: { identifier: symbol, consolidated },
    },
    // NSE-only: these three hit nseindia.com by ticker and have no BSE equivalent.
    ...(exchange === "NSE"
      ? [
          { slot: "quote", label: "NSE LIVE QUOTE", tool: "nse_get_quote", args: { symbol } },
          {
            slot: "announcements",
            label: "NSE ANNOUNCEMENTS",
            tool: "nse_get_announcements",
            args: { symbol, limit },
          },
          {
            slot: "corporateActions",
            label: "NSE CORP ACTIONS",
            tool: "nse_get_corporate_actions",
            args: { symbol, limit },
          },
        ]
      : []),
    ...INDICATORS.map(([slot, indicator, timePeriod]) => ({
      slot: `technicals.${slot}`,
      label: `${indicator}${timePeriod ? ` ${timePeriod}` : ""} daily [${exchange}]`,
      tool: "technical_get_indicator",
      args: {
        ticker: symbol,
        exchange,
        indicator,
        interval: "daily",
        limit: 5,
        ...(timePeriod ? { time_period: timePeriod } : {}),
      },
    })),
  ];
}
