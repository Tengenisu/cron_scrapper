import { MCP_CONSOLIDATED, MCP_LIST_LIMIT } from "../constants.js";
import type { McpJobSpec } from "../types.js";

/**
 * The full-dump job catalogue: every MCP tool call fired for one NSE symbol.
 *
 * This is the direct descendant of the `node -e` one-liner the old
 * `mcp_query.js` wrapped — 19 calls per symbol, in a fixed order, so two runs of
 * the same symbol are diffable line by line.
 */

const STATEMENTS = ["quarters", "profit-loss", "balance-sheet", "cash-flow", "ratios"] as const;

/** [indicator, time_period] — MACD takes no period (it is fixed at 12/26/9). */
const INDICATORS: readonly [string, number | null][] = [
  ["RSI", 14],
  ["SMA", 50],
  ["EMA", 200],
  ["MACD", null],
];

const EXCHANGES = ["NSE", "BSE"] as const;

export function buildJobCatalog(
  symbol: string,
  options: { consolidated?: boolean; limit?: number } = {}
): McpJobSpec[] {
  const consolidated = options.consolidated ?? MCP_CONSOLIDATED;
  const limit = options.limit ?? MCP_LIST_LIMIT;

  return [
    { label: "SEARCH MATCH", tool: "screener_search_companies", args: { query: symbol } },
    {
      label: "COMPANY OVERVIEW",
      tool: "screener_get_company_overview",
      args: { identifier: symbol, consolidated },
    },
    ...STATEMENTS.map((statement) => ({
      label: statement.toUpperCase(),
      tool: "screener_get_financial_statement",
      args: { identifier: symbol, statement, consolidated },
    })),
    {
      label: "PEER COMPARISON",
      tool: "screener_get_peer_comparison",
      args: { identifier: symbol, consolidated },
    },
    { label: "NSE LIVE QUOTE", tool: "nse_get_quote", args: { symbol } },
    { label: "NSE ANNOUNCEMENTS", tool: "nse_get_announcements", args: { symbol, limit } },
    { label: "NSE CORP ACTIONS", tool: "nse_get_corporate_actions", args: { symbol, limit } },
    ...EXCHANGES.flatMap((exchange) =>
      INDICATORS.map(([indicator, timePeriod]) => ({
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
      }))
    ),
  ];
}
