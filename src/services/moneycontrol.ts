import { EARNINGS_URL } from "../constants.js";
import { fetchText, ScraperRequestError } from "./http.js";
import { toNumber, toText } from "./format.js";
import { log } from "./log.js";
import type { CalendarEntry, EarningsSections, QuarterMetric, RapidResult } from "../types.js";

/**
 * moneycontrol.com/markets/earnings is a Next.js app and both sections we want
 * are server-rendered into the `__NEXT_DATA__` blob — so no headless browser and
 * no DOM scraping of the rendered table: read the JSON the page shipped with.
 *
 * If `__NEXT_DATA__ not found` starts appearing, Moneycontrol has changed the
 * page or is blocking the request. That is the one failure mode worth alerting on.
 */

const NEXT_DATA_ID = "__NEXT_DATA__";

interface NextDataEnvelope {
  props?: { pageProps?: { earningsDashboardData?: EarningsDashboard } };
}

interface EarningsDashboard {
  resCalTodayDate?: string;
  resCalFromDate?: string;
  resCalToDate?: string;
  resCalData?: { list?: RawCalendarRow[] };
  rapResData?: {
    baseURL?: string;
    tableHeader?: string[];
    header?: { name?: string }[];
    list?: unknown[][];
  };
}

interface RawCalendarRow {
  date?: string;
  stockName?: string;
  stockShortName?: string;
  scId?: string;
  exchange?: string;
  resultType?: string;
  ltp?: string | number;
  change?: string | number;
  time?: string;
  marketCap?: string | number;
  stockUrl?: string;
  seeFinancial?: string;
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
export function parseResultCalendar(dashboard: EarningsDashboard): CalendarEntry[] {
  const rows = dashboard.resCalData?.list ?? [];
  return rows.map((row) => ({
    date: toText(row.date),
    company: toText(row.stockName),
    shortName: toText(row.stockShortName),
    scId: toText(row.scId),
    exchange: toText(row.exchange),
    resultType: toText(row.resultType),
    ltp: toNumber(row.ltp),
    changePercent: toNumber(row.change),
    time: toText(row.time),
    marketCap: toNumber(row.marketCap),
    url: toText(row.stockUrl),
    financialsUrl: toText(row.seeFinancial),
    nseSymbol: null, // filled in by the symbol resolver
  }));
}

/**
 * RAPID RESULTS — companies that have *just posted* results.
 *
 * The rows arrive as positional arrays; `header[].name` is the column order, so
 * the two are zipped back into objects before anything is read by name.
 */
export function parseRapidResults(dashboard: EarningsDashboard): RapidResult[] {
  const block = dashboard.rapResData ?? {};
  const baseUrl = block.baseURL ?? "";
  const names = (block.header ?? []).map((header) => header.name ?? "");
  const columns = block.tableHeader ?? [];

  return (block.list ?? []).map((row) => {
    const record: Record<string, unknown> = {};
    names.forEach((name, index) => {
      if (name) record[name] = row[index];
    });

    const quarterData: QuarterMetric[] = (
      Array.isArray(record["quarterData"]) ? (record["quarterData"] as unknown[]) : []
    ).map((metric) => {
      const cells = Array.isArray(metric) ? (metric as unknown[]) : [];
      return {
        metric: toText(cells[0]),
        current: toNumber(cells[1]),
        previous: toNumber(cells[2]),
        growthPercent: toNumber(cells[3]),
      };
    });

    const seo = toText(record["seoString"]);
    return {
      date: toText(record["date"]),
      company: toText(record["stockName"]),
      scId: toText(record["scID"] ?? record["scId"]),
      exchange: toText(record["exchange"]),
      ltp: toNumber(record["ltp"]),
      changePercent: toNumber(record["changeP"]),
      financialType: toText(record["financialType"]),
      period: columns[0] ?? null,
      columns,
      quarterData,
      url: seo ? `${baseUrl}${seo}` : null,
      nseSymbol: null,
    };
  });
}

/** Fetches the page once and parses whichever sections were asked for. */
export async function scrapeEarnings(
  sections: "both" | "calendar" | "rapid"
): Promise<EarningsSections> {
  const dashboard = await fetchEarningsDashboard();

  const result: EarningsSections = {
    calendarDate: toText(dashboard.resCalTodayDate),
    calendarRange: {
      from: toText(dashboard.resCalFromDate),
      to: toText(dashboard.resCalToDate),
    },
    resultCalendar: sections === "rapid" ? [] : parseResultCalendar(dashboard),
    rapidResults: sections === "calendar" ? [] : parseRapidResults(dashboard),
  };

  log.info(
    `scraped ${result.resultCalendar.length} calendar row(s) and ${result.rapidResults.length} rapid result(s)`
  );
  return result;
}
