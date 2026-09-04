import fs from "node:fs";
import path from "node:path";
import { CACHE_ENABLED, PRICE_FEED_URL, SYMBOL_CACHE_FILE } from "../constants.js";
import { PriceFeedResponseSchema } from "../schemas/index.js";
import { fetchJson } from "./http.js";
import { errorMessage } from "./format.js";
import { log } from "./log.js";

/**
 * scId -> NSE trading symbol ("DTL03" -> "DHOOTTRANS").
 *
 * Moneycontrol's price feed is the only public mapping; the `scId` on the
 * earnings page is authoritative, unlike the trailing token in the stock URL,
 * which is a *different* id and resolves to the wrong company.
 *
 * With the cache disabled (the default in testing mode) nothing is remembered
 * and nothing is written: every scId is looked up live on every run.
 */

/** Moneycontrol group codes -> the price feed's exchange segment. */
const EXCHANGE_SEGMENT: Record<string, string> = { N: "nse", B: "bse" };

const BLANK_SYMBOLS = new Set(["", "-", "--"]);

export class SymbolResolver {
  private readonly cachePath: string;
  private readonly enabled: boolean;
  private readonly cache = new Map<string, string | null>();
  private dirty = false;

  constructor(cachePath: string = SYMBOL_CACHE_FILE, enabled: boolean = CACHE_ENABLED) {
    this.enabled = Boolean(enabled && cachePath);
    this.cachePath = this.enabled ? cachePath : "";
    if (this.enabled) this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as Record<string, string>;
      for (const [scId, symbol] of Object.entries(parsed)) this.cache.set(scId, symbol);
      log.debug(`loaded ${this.cache.size} cached symbol(s) from ${this.cachePath}`);
    } catch (err) {
      log.warn(`ignoring unreadable symbol cache ${this.cachePath}: ${errorMessage(err)}`);
    }
  }

  async resolve(scId: string | null, exchange: string | null = "N"): Promise<string | null> {
    if (!scId) return null;
    if (this.enabled && this.cache.has(scId)) return this.cache.get(scId) ?? null;

    // Try the stock's own segment first, then NSE — a BSE-grouped scrip can
    // still carry an NSEID, and vice versa.
    const primary = EXCHANGE_SEGMENT[(exchange ?? "N").toUpperCase()] ?? "nse";
    const segments = primary === "nse" ? ["nse"] : [primary, "nse"];

    let symbol: string | null = null;
    for (const segment of segments) {
      const url = PRICE_FEED_URL.replace("{exchange}", segment).replace("{scId}", scId);
      try {
        const payload = PriceFeedResponseSchema.parse(await fetchJson<unknown>(url));
        const candidate = (payload.data?.NSEID ?? "").trim();
        if (!BLANK_SYMBOLS.has(candidate)) {
          symbol = candidate;
          break;
        }
      } catch (err) {
        log.warn(`price feed failed for ${scId} (${segment}): ${errorMessage(err)}`);
      }
    }

    if (symbol === null) log.info(`no NSE symbol for scId=${scId} (exchange=${exchange ?? "N"})`);
    if (this.enabled) {
      this.cache.set(scId, symbol);
      this.dirty = true;
    }
    return symbol;
  }

  save(): void {
    if (!this.enabled || !this.dirty) return;
    // Only successful lookups are persisted: a BSE-only scrip may list on the
    // NSE later, and a cached null would hide it forever.
    const resolved = Object.fromEntries(
      [...this.cache.entries()].filter(([, symbol]) => Boolean(symbol)).sort(([a], [b]) => a.localeCompare(b))
    );
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(resolved, null, 1), "utf8");
      fs.renameSync(tmp, this.cachePath);
      this.dirty = false;
    } catch (err) {
      log.warn(`could not write symbol cache: ${errorMessage(err)}`);
    }
  }
}
