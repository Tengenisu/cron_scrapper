#!/usr/bin/env node
/**
 * Full MCP dump for one NSE symbol.
 *
 * Usage:  node mcp_query.js TECHNOCRAF
 *
 * This is the `node -e` one-liner from the supervisor repo, kept as a file so
 * it survives cmd.exe/PowerShell quoting. Every run talks to the MCP server
 * directly and nothing is cached: each request carries no-cache headers and a
 * fresh JSON-RPC id, so the output is regenerated on every invocation.
 */
const ID = process.argv[2] || process.env.SYMBOL;
if (!ID) {
  console.error("usage: node mcp_query.js <NSE_SYMBOL>");
  process.exit(2);
}
const SYM = ID;
const CONS = true;
const ENDPOINT = process.env.MCP_ENDPOINT || "http://127.0.0.1:3123/mcp";

const STMTS = ["quarters", "profit-loss", "balance-sheet", "cash-flow", "ratios"];
const TECH = [["RSI", 14], ["SMA", 50], ["EMA", 200], ["MACD", 0]];

const JOBS = [
  ["SEARCH MATCH", "screener_search_companies", { query: ID }],
  ["COMPANY OVERVIEW", "screener_get_company_overview", { identifier: ID, consolidated: CONS }],
  ...STMTS.map(s => [
    s.toUpperCase(),
    "screener_get_financial_statement",
    { identifier: ID, statement: s, consolidated: CONS },
  ]),
  ["PEER COMPARISON", "screener_get_peer_comparison", { identifier: ID, consolidated: CONS }],
  ["NSE LIVE QUOTE", "nse_get_quote", { symbol: SYM }],
  ["NSE ANNOUNCEMENTS", "nse_get_announcements", { symbol: SYM, limit: 10 }],
  ["NSE CORP ACTIONS", "nse_get_corporate_actions", { symbol: SYM, limit: 10 }],
  ...["NSE", "BSE"].flatMap(ex =>
    TECH.map(([ind, tp]) => [
      ind + (tp ? " " + tp : "") + " daily [" + ex + "]",
      "technical_get_indicator",
      Object.assign(
        { ticker: SYM, exchange: ex, indicator: ind, interval: "daily", limit: 5 },
        tp ? { time_period: tp } : {}
      ),
    ])
  ),
];

function parseBody(b) {
  const t = b.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const l = t.split(/\r?\n/).filter(x => x.startsWith("data:")).pop();
  if (!l) throw new Error("unparseable response: " + t.slice(0, 200));
  return JSON.parse(l.slice(5).trim());
}

function render(d) {
  if (d.error) return "RPC ERROR: " + JSON.stringify(d.error);
  const c = d.result && d.result.content;
  if (!Array.isArray(c)) return JSON.stringify(d.result ?? d, null, 2);
  return c.map(x => x.text ?? JSON.stringify(x)).join("\n");
}

const call = (name, args, id) =>
  fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // never serve us a cached answer -- this dump must be live every run
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    },
    cache: "no-store",
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  })
    .then(r => r.text())
    .then(b => render(parseBody(b)))
    .catch(e => "REQUEST FAILED: " + e.message);

(async () => {
  console.log(
    "=".repeat(72) + "\nFULL DUMP  |  " + ID + "  |  " + new Date().toISOString() + "\n" + "=".repeat(72)
  );
  for (let i = 0; i < JOBS.length; i++) {
    const [label, tool, args] = JOBS[i];
    const text = await call(tool, args, Date.now() + i);
    console.log("\n\n" + "-".repeat(72) + "\n## " + label + "   [" + tool + "]\n" + "-".repeat(72) + "\n");
    console.log(text);
  }
})();
