/**
 * The body of the "Scrape + MCP" Code node in
 * moneycontrol-earnings-scraper.json — kept here as a real file so it can be
 * read, diffed and linted, and embedded into the workflow with:
 *
 *     npm run n8n:sync
 *
 * n8n Code node, language: JavaScript, mode: Run Once for All Items.
 *
 * It is a self-contained port of src/ (scrape → resolve NSE symbols → MCP dump)
 * so the workflow needs nothing installed in the container: no repo clone, no
 * npm install, no python — n8n's image ships Node, which is the whole reason
 * this repo moved off Python.
 *
 * The task runner kills a task at ~60s while a full pass over every symbol takes
 * longer, so enrichment runs under DEADLINE_MS and the starting symbol rotates
 * every tick: each run returns inside the limit and successive runs cover the
 * rest. Symbols not reached this tick come back with mcpStatus "pending" rather
 * than being dropped.
 */

const EARNINGS_URL = "https://www.moneycontrol.com/markets/earnings/";
const PRICE_FEED_URL = "https://priceapi.moneycontrol.com/pricefeed/{exchange}/equitycash/{scId}";
const MCP_ENDPOINT = "http://127.0.0.1:3123/mcp";

const HTTP_TIMEOUT_MS = 20000;
const HTTP_RETRIES = 2;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Stay well under the runner's ~60s task timeout: an in-flight HTTP call cannot
// be interrupted, so leave room for one to overshoot the deadline.
const DEADLINE_MS = 40000;
const CONSOLIDATED = true;
const LIST_LIMIT = 10;

const STARTED = Date.now();
const remaining = () => DEADLINE_MS - (Date.now() - STARTED);

const NEXT_DATA_OPEN = '<script id="__NEXT_DATA__" type="application/json">';
const EXCHANGE_SEGMENT = { N: "nse", B: "bse" };

const helpers = this.helpers;

// --------------------------------------------------------------------------- //
// HTTP
// --------------------------------------------------------------------------- //

/** GET/POST returning text. Uses global fetch where the runner exposes it. */
async function httpText(url, options = {}) {
  const { method = "GET", body = null, headers = {} } = options;
  const allHeaders = {
    "User-Agent": USER_AGENT,
    "Accept-Language": "en-US,en;q=0.9",
    // nothing is cached: every run must regenerate its data
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    ...headers,
  };

  let lastError = null;
  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    try {
      if (typeof fetch === "function") {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            method,
            headers: allHeaders,
            body,
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) throw new Error("HTTP " + response.status);
          return text;
        } finally {
          clearTimeout(timer);
        }
      }
      return await helpers.httpRequest({
        url,
        method,
        headers: allHeaders,
        body,
        json: false,
        timeout: HTTP_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = err;
      if (attempt + 1 < HTTP_RETRIES && remaining() > 5000) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } else {
        break;
      }
    }
  }
  throw new Error(url + " -> " + (lastError && lastError.message ? lastError.message : lastError));
}

const cacheBust = (url) => url + (url.includes("?") ? "&" : "?") + "_=" + Date.now();

// --------------------------------------------------------------------------- //
// Moneycontrol page
// --------------------------------------------------------------------------- //

async function fetchEarnings() {
  const html = await httpText(cacheBust(EARNINGS_URL), { headers: { Accept: "text/html,*/*;q=0.8" } });
  const start = html.indexOf(NEXT_DATA_OPEN);
  if (start === -1) throw new Error("__NEXT_DATA__ not found — page changed or request blocked");
  const from = start + NEXT_DATA_OPEN.length;
  const end = html.indexOf("</script>", from);
  if (end === -1) throw new Error("__NEXT_DATA__ script tag is not terminated");
  const blob = JSON.parse(html.slice(from, end));
  const dashboard = blob && blob.props && blob.props.pageProps && blob.props.pageProps.earningsDashboardData;
  if (!dashboard) throw new Error("earningsDashboardData missing from __NEXT_DATA__");
  return dashboard;
}

function num(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text === "-" || text === "--") return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseResultCalendar(dashboard) {
  const rows = (dashboard.resCalData && dashboard.resCalData.list) || [];
  return rows.map((row) => ({
    section: "resultCalendar",
    date: row.date ?? null,
    company: row.stockName ?? null,
    shortName: row.stockShortName ?? null,
    scId: row.scId ?? null,
    exchange: row.exchange ?? null,
    resultType: row.resultType ?? null,
    ltp: num(row.ltp),
    changePercent: num(row.change),
    time: row.time ?? null,
    marketCap: num(row.marketCap),
    url: row.stockUrl ?? null,
  }));
}

function parseRapidResults(dashboard) {
  const block = dashboard.rapResData || {};
  const baseUrl = block.baseURL || "";
  const names = (block.header || []).map((h) => h.name || "");
  const columns = block.tableHeader || [];

  return (block.list || []).map((row) => {
    const record = {};
    names.forEach((name, index) => {
      if (name) record[name] = row[index];
    });

    const quarterData = (Array.isArray(record.quarterData) ? record.quarterData : []).map((metric) => {
      const cells = Array.isArray(metric) ? metric : [];
      return {
        metric: cells[0] ?? null,
        current: num(cells[1]),
        previous: num(cells[2]),
        growthPercent: num(cells[3]),
      };
    });

    const seo = record.seoString || "";
    return {
      section: "rapidResults",
      date: record.date ?? null,
      company: record.stockName ?? null,
      scId: record.scID ?? record.scId ?? null,
      exchange: record.exchange ?? null,
      ltp: num(record.ltp),
      changePercent: num(record.changeP),
      financialType: record.financialType ?? null,
      resultType: columns[0] ?? null,
      columns,
      quarterData,
      url: seo ? baseUrl + seo : null,
    };
  });
}

/** scId -> NSE symbol. Never cached: looked up live on every run. */
async function resolveSymbol(scId, exchange) {
  if (!scId) return null;
  const primary = EXCHANGE_SEGMENT[String(exchange || "N").toUpperCase()] || "nse";
  const segments = primary === "nse" ? ["nse"] : [primary, "nse"];

  for (const segment of segments) {
    try {
      const url = PRICE_FEED_URL.replace("{exchange}", segment).replace("{scId}", scId);
      const payload = JSON.parse(await httpText(url, { headers: { Accept: "application/json" } }));
      const candidate = String((payload && payload.data && payload.data.NSEID) || "").trim();
      if (candidate && candidate !== "-" && candidate !== "--") return candidate;
    } catch (err) {
      // try the next segment; a missing mapping is normal for BSE-only scrips
    }
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Markdown -> JSON (the parts of src/services/markdown.ts the MCP output uses)
// --------------------------------------------------------------------------- //

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const KEYVAL = /^\s*\*{0,2}([A-Za-z0-9][^:*]{0,60}?)\*{0,2}\s*:\s+(.*\S)\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NULLS = new Set(["", "-", "--", "—", "–", "N/A", "NA", "null", "None"]);

function coerce(value) {
  const trimmed = String(value).trim();
  if (NULLS.has(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";
  const cleaned = trimmed.replace(/,/g, "").replace(/%/g, "").replace(/₹/g, "").trim();
  if (/^[+-]?\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  if (/^[+-]?\d*\.\d+$/.test(cleaned)) return Number.parseFloat(cleaned);
  return trimmed;
}

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

function markdownToObject(markdown) {
  const lines = String(markdown == null ? "" : markdown).replace(/\r\n/g, "\n").split("\n");
  const fields = {};
  const tables = [];
  const items = [];
  const text = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("|") && TABLE_SEP.test(lines[i + 1] || "")) {
      const headers = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitRow(lines[i]);
        const row = {};
        headers.forEach((header, n) => {
          row[header || "col" + n] = coerce(cells[n] ?? "");
        });
        rows.push(row);
        i++;
      }
      tables.push(rows);
      continue;
    }

    if (HEADING.test(line)) {
      i++;
      continue;
    }

    const bullet = BULLET.exec(line);
    const candidate = bullet ? bullet[1] : line;
    const keyval = KEYVAL.exec(candidate);
    if (keyval) fields[keyval[1].trim()] = coerce(keyval[2]);
    else if (bullet) items.push(candidate.trim());
    else if (line.trim()) text.push(line.replace(/\s+$/, ""));
    i++;
  }

  return { fields, tables, items, text: text.join("\n").trim() };
}

// --------------------------------------------------------------------------- //
// MCP — the src/tools/catalog.ts job list, called straight over JSON-RPC
// --------------------------------------------------------------------------- //

const STATEMENTS = ["quarters", "profit-loss", "balance-sheet", "cash-flow", "ratios"];
const INDICATORS = [
  ["RSI", 14],
  ["SMA", 50],
  ["EMA", 200],
  ["MACD", 0],
];
const FAILURE_PREFIXES = ["REQUEST FAILED:", "RPC ERROR:", "Error:"];
const EMPTY_MARKERS = [
  "No corporate actions found",
  "No recent announcements found",
  "Not enough price history",
  "No data",
  "_No rows returned._",
];

function jobsFor(symbol) {
  return [
    ["SEARCH MATCH", "screener_search_companies", { query: symbol }],
    ["COMPANY OVERVIEW", "screener_get_company_overview", { identifier: symbol, consolidated: CONSOLIDATED }],
    ...STATEMENTS.map((statement) => [
      statement.toUpperCase(),
      "screener_get_financial_statement",
      { identifier: symbol, statement: statement, consolidated: CONSOLIDATED },
    ]),
    ["PEER COMPARISON", "screener_get_peer_comparison", { identifier: symbol, consolidated: CONSOLIDATED }],
    ["NSE LIVE QUOTE", "nse_get_quote", { symbol: symbol }],
    ["NSE ANNOUNCEMENTS", "nse_get_announcements", { symbol: symbol, limit: LIST_LIMIT }],
    ["NSE CORP ACTIONS", "nse_get_corporate_actions", { symbol: symbol, limit: LIST_LIMIT }],
    ...["NSE", "BSE"].flatMap((exchange) =>
      INDICATORS.map(([indicator, period]) => [
        indicator + (period ? " " + period : "") + " daily [" + exchange + "]",
        "technical_get_indicator",
        Object.assign(
          { ticker: symbol, exchange: exchange, indicator: indicator, interval: "daily", limit: 5 },
          period ? { time_period: period } : {}
        ),
      ])
    ),
  ];
}

/** One tools/call. Handles both plain JSON and SSE (data:) replies. */
async function mcpCall(tool, args, id) {
  let raw;
  try {
    raw = await httpText(MCP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: id, method: "tools/call", params: { name: tool, arguments: args } }),
    });
  } catch (err) {
    return "REQUEST FAILED: " + err.message;
  }

  let text = raw.trim();
  if (!text.startsWith("{")) {
    const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
    if (dataLines.length === 0) return "REQUEST FAILED: unparseable response: " + text.slice(0, 200);
    text = dataLines[dataLines.length - 1].slice(5).trim();
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    return "REQUEST FAILED: " + err.message;
  }

  if (payload.error) return "RPC ERROR: " + JSON.stringify(payload.error);
  const content = payload.result && payload.result.content;
  if (!Array.isArray(content)) return JSON.stringify(payload.result || payload, null, 2);
  return content.map((part) => part.text || JSON.stringify(part)).join("\n");
}

function classify(body) {
  const head = body.trimStart();
  for (const prefix of FAILURE_PREFIXES) {
    if (head.startsWith(prefix)) return { ok: false, error: head.split("\n")[0].trim(), empty: false };
  }
  if (EMPTY_MARKERS.some((marker) => head.startsWith(marker))) return { ok: true, error: null, empty: true };
  return { ok: true, error: null, empty: head.length === 0 };
}

/** The 19-call full dump for one symbol, as structured JSON. */
async function mcpDump(symbol, baseId) {
  const jobs = [];
  const specs = jobsFor(symbol);

  for (let offset = 0; offset < specs.length; offset++) {
    const [label, tool, args] = specs[offset];

    if (remaining() <= 3000) {
      jobs.push({ label: label, tool: tool, ok: true, error: null, empty: true, pending: true });
      continue;
    }

    const body = await mcpCall(tool, args, baseId + offset);
    const verdict = classify(body);
    const job = {
      label: label,
      tool: tool,
      ok: verdict.ok,
      error: verdict.error,
      empty: verdict.empty,
      pending: false,
    };

    if (verdict.ok && !verdict.empty) {
      const head = body.trimStart();
      if (head.startsWith("{") || head.startsWith("[")) {
        try {
          job.data = JSON.parse(head);
        } catch (err) {
          job.content = markdownToObject(body);
        }
      } else {
        job.content = markdownToObject(body);
      }
    }
    job.raw = body;
    jobs.push(job);
  }

  return {
    symbol: symbol,
    generatedAt: new Date().toISOString(),
    jobs: jobs,
    counts: {
      total: jobs.length,
      ok: jobs.filter((j) => j.ok && !j.pending).length,
      failed: jobs.filter((j) => !j.ok).length,
      empty: jobs.filter((j) => j.empty && !j.pending).length,
      pending: jobs.filter((j) => j.pending).length,
    },
  };
}

// --------------------------------------------------------------------------- //
// Main — one output item per company
// --------------------------------------------------------------------------- //

const scrapedAt = new Date().toISOString();

let dashboard;
try {
  dashboard = await fetchEarnings();
} catch (err) {
  return [{ json: { ok: false, skipped: false, scrapedAt: scrapedAt, error: "scrape failed: " + err.message } }];
}

const records = [...parseResultCalendar(dashboard), ...parseRapidResults(dashboard)];
for (const record of records) {
  record.nseSymbol = await resolveSymbol(record.scId, record.exchange || "N");
}

const symbols = [...new Set(records.map((r) => r.nseSymbol).filter(Boolean))].sort();

// Rotate the starting symbol so consecutive ticks cover different ones instead
// of always enriching the same head of the list.
const dumps = {};
if (symbols.length > 0) {
  const start = Math.floor(Date.now() / DEADLINE_MS) % symbols.length;
  const order = [...symbols.slice(start), ...symbols.slice(0, start)];
  for (let n = 0; n < order.length; n++) {
    if (remaining() <= 5000) break;
    dumps[order[n]] = await mcpDump(order[n], 1000 * (n + 1));
  }
}

const out = records.map((record) => {
  const symbol = record.nseSymbol;
  const dump = dumps[symbol];
  const mcpStatus = !symbol ? "no-nse-symbol" : dump ? "done" : "pending";

  return {
    json: {
      ok: true,
      skipped: false,
      scrapedAt: scrapedAt,
      calendarDate: dashboard.resCalTodayDate ?? null,
      cacheEnabled: false,
      section: record.section,
      company: record.company,
      scId: record.scId,
      nseSymbol: symbol,
      exchange: record.exchange,
      ltp: record.ltp,
      changePercent: record.changePercent,
      resultType: record.resultType,
      record: record,
      mcpStatus: mcpStatus,
      mcpCounts: dump ? dump.counts : null,
      mcp: dump || null,
      elapsedSeconds: Math.round((Date.now() - STARTED) / 100) / 10,
      symbolsTotal: symbols.length,
      symbolsEnriched: Object.keys(dumps).length,
    },
  };
});

return out.length > 0
  ? out
  : [{ json: { ok: true, skipped: true, scrapedAt: scrapedAt, reason: "no companies listed on the page right now" } }];
