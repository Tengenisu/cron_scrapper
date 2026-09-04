import { EARNINGS_URL } from "../constants.js";
import { fetchText, ScraperRequestError } from "./http.js";
import { toText } from "./format.js";
import { log } from "./log.js";
import type { ScrapedRow, SectionSelection } from "../types.js";

/**
 * moneycontrol.com/markets/earnings is a Next.js app and both sections we want
 * are server-rendered into the `__NEXT_DATA__` blob — so no headless browser and
 * no DOM scraping of the rendered table: read the JSON the page shipped with.
 *
 * The page is used purely as a *scan*: which companies have results, and what
 * Moneycontrol calls them. Its own numbers — price, change, market cap, its
 * revenue/profit table — are deliberately not read: everything downstream comes
 * from the MCP server, and carrying a second, differently-sourced copy of the
 * same figures alongside it is how two answers to one question get shipped.
 *
 * If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the
 * page or is blocking the request. That is the one failure mode worth alerting on.
 */

const NEXT_DATA_ID = "__NEXT_DATA__";

interface NextDataEnvelope {
  props?: { pageProps?: { earningsDashboardData?: EarningsDashboard } };
}

interface EarningsDashboard {
  resCalData?: { list?: { stockName?: string; scId?: string; exchange?: string }[] };
  rapResData?: { header?: { name?: string }[]; list?: unknown[][] };
}

/**
 * Pulls the __NEXT_DATA__ JSON out of the page source.
 *
 * Deliberately a string scan rather than a cheerio selector: the blob routinely
 * runs past a megabyte and contains escaped markup, and slicing between the
 * script tags is both faster and less likely to be mangled by an HTML parser.
 */
export function extractNextData(html: string): NextDataEnvelope {
  const openTag = new RegExp(`<script[^>]*id="${NEXT_DATA_ID}"[^>]*>`).exec(html);
  if (!openTag) {
    throw new ScraperRequestError(
      `${NEXT_DATA_ID} not found — the page layout changed or the request was blocked.`
    );
  }
  const start = openTag.index + openTag[0].length;
  const end = html.indexOf("</script>", start);
  if (end === -1) {
    throw new ScraperRequestError(`${NEXT_DATA_ID} script tag is not terminated.`);
  }

  try {
    return JSON.parse(html.slice(start, end)) as NextDataEnvelope;
  } catch (err) {
    throw new ScraperRequestError(
      `${NEXT_DATA_ID} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function fetchEarningsDashboard(): Promise<EarningsDashboard> {
  const html = await fetchText(EARNINGS_URL);
  const dashboard = extractNextData(html).props?.pageProps?.earningsDashboardData;
  if (!dashboard) {
    throw new ScraperRequestError(
      "earningsDashboardData missing from __NEXT_DATA__ — Moneycontrol changed the page shape."
    );
  }
  return dashboard;
}

/** RESULT CALENDAR — companies *about to* release quarterly numbers. */
export function parseResultCalendar(dashboard: EarningsDashboard): ScrapedRow[] {
  return (dashboard.resCalData?.list ?? []).map((row) => ({
    company: toText(row.stockName),
    scId: toText(row.scId),
    exchange: toText(row.exchange),
    events: ["upcoming" as const],
  }));
}

/**
 * RAPID RESULTS — companies that have *just posted* results.
 *
 * The rows arrive as positional arrays; `header[].name` is the column order, so
 * the two are zipped back into objects before anything is read by name.
 */
export function parseRapidResults(dashboard: EarningsDashboard): ScrapedRow[] {
  const block = dashboard.rapResData ?? {};
  const names = (block.header ?? []).map((header) => header.name ?? "");

  return (block.list ?? []).map((row) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (name) record[name] = row[index];
    });

    return {
      company: toText(record["stockName"]),
      scId: toText(record["scID"] ?? record["scId"]),
      exchange: toText(record["exchange"]),
      events: ["reported" as const],
    };
  });
}

/**
 * Fetches the page once and returns every company it lists, collapsed by scId.
 *
 * This is not result dedup — every run still emits the full current scan, and
 * n8n decides what is new. It only stops one company that appears in both
 * sections from being dumped from the MCP server twice in the same pass; its
 * `events` then carries both reasons it was picked up.
 */
export async function scanEarnings(sections: SectionSelection): Promise<ScrapedRow[]> {
  const dashboard = await fetchEarningsDashboard();

  const calendar = sections === "rapid" ? [] : parseResultCalendar(dashboard);
  const rapid = sections === "calendar" ? [] : parseRapidResults(dashboard);

  const byScId = new Map<string, ScrapedRow>();
  const rows: ScrapedRow[] = [];
  for (const row of [...rapid, ...calendar]) {
    const seen = row.scId ? byScId.get(row.scId) : undefined;
    if (seen) {
      for (const event of row.events) if (!seen.events.includes(event)) seen.events.push(event);
      continue;
    }
    if (row.scId) byScId.set(row.scId, row);
    rows.push(row); // a row with no scId can't be keyed; keep it so the gap shows
  }

  log.info(
    `scanned ${rapid.length} reported + ${calendar.length} upcoming = ${rows.length} distinct stock(s)`
  );
  return rows;
}
