import fs from "node:fs";
import path from "node:path";
import { CACHE_ENABLED, PRICE_FEED_URL, SYMBOL_CACHE_FILE } from "../constants.js";
import { PriceFeedResponseSchema } from "../schemas/index.js";
import { fetchJson } from "./http.js";
import { errorMessage } from "./format.js";
import { log } from "./log.js";
import type { ResolvedSymbol } from "../types.js";

/**
 * scId -> the symbol the MCP server can look the stock up by.
 *
 * NSE first ("DTL03" -> "DHOOTTRANS"), and when a scrip has no NSE listing, its
 * BSE scrip code ("VIVAN54173" -> "541735"). The code is a real identifier
 * downstream: screener.in serves /company/541735/ and Yahoo (which the technical
 * indicators read) takes 541735.BO — so a BSE-only stock is dumped like any
 * other instead of being dropped.
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

function clean(value: string | undefined): string | null {
  const candidate = (value ?? "").trim();
  return BLANK_SYMBOLS.has(candidate) ? null : candidate;
}

export class SymbolResolver {
  private readonly cachePath: string;
  private readonly enabled: boolean;
  private readonly cache = new Map<string, ResolvedSymbol | null>();
  private dirty = false;

  constructor(cachePath: string = SYMBOL_CACHE_FILE, enabled: boolean = CACHE_ENABLED) {
    this.enabled = Boolean(enabled && cachePath);
    this.cachePath = this.enabled ? cachePath : "";
    if (this.enabled) this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.cachePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, "utf8")) as Record<string, ResolvedSymbol>;
      for (const [scId, resolved] of Object.entries(parsed)) {
        if (resolved?.symbol && resolved?.exchange) this.cache.set(scId, resolved);
      }
      log.debug(`loaded ${this.cache.size} cached symbol(s) from ${this.cachePath}`);
    } catch (err) {
      log.warn(`ignoring unreadable symbol cache ${this.cachePath}: ${errorMessage(err)}`);
    }
  }

  async resolve(scId: string | null, exchange: string | null = "N"): Promise<ResolvedSymbol | null> {
    if (!scId) return null;
    if (this.enabled && this.cache.has(scId)) return this.cache.get(scId) ?? null;

    // Query the stock's own segment first, then the other one — the feed answers
    // for either segment with the same record, but a BSE-grouped scrip is more
    // reliably found under /bse/.
    const primary = EXCHANGE_SEGMENT[(exchange ?? "N").toUpperCase()] ?? "nse";
    const segments = primary === "nse" ? ["nse", "bse"] : ["bse", "nse"];

    let resolved: ResolvedSymbol | null = null;
    for (const segment of segments) {
      const url = PRICE_FEED_URL.replace("{exchange}", segment).replace("{scId}", scId);
      try {
        const payload = PriceFeedResponseSchema.parse(await fetchJson<unknown>(url));
        // NSE wins when the stock has both listings: its symbol is the one every
        // downstream tool — screener, NSE announcements, Yahoo — understands.
        const nse = clean(payload.data?.NSEID);
        const bse = clean(payload.data?.BSEID);
        if (nse) resolved = { symbol: nse, exchange: "NSE" };
        else if (bse) resolved = { symbol: bse, exchange: "BSE" };
        if (resolved) break;
      } catch (err) {
        log.warn(`price feed failed for ${scId} (${segment}): ${errorMessage(err)}`);
      }
    }

    if (resolved === null) log.info(`no NSE or BSE symbol for scId=${scId} (exchange=${exchange ?? "N"})`);
    if (this.enabled) {
      this.cache.set(scId, resolved);
      this.dirty = true;
    }
    return resolved;
  }

  save(): void {
    if (!this.enabled || !this.dirty) return;
    // Only successful lookups are persisted: an unresolved scrip may list later,
    // and a cached null would hide it forever.
    const resolved = Object.fromEntries(
      [...this.cache.entries()]
        .filter((entry): entry is [string, ResolvedSymbol] => Boolean(entry[1]))
        .sort(([a], [b]) => a.localeCompare(b))
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
