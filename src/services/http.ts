import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";
import {
  CACHE_ENABLED,
  CACHE_TTL_MS,
  DEFAULT_HEADERS,
  HTTP_BACKOFF_MS,
  HTTP_RETRIES,
  MIN_REQUEST_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "../constants.js";
import { log } from "./log.js";

interface CacheEntry {
  expiresAt: number;
  data: string;
}

const cache = new Map<string, CacheEntry>();
let lastRequestAt = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function throttle(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export class ScraperRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message);
    this.name = "ScraperRequestError";
  }
}

export interface FetchOptions {
  referer?: string;
  /** Append a `_=<epoch>` param so no CDN or proxy can hand back a stale copy. */
  bustCache?: boolean;
}

/**
 * GETs a URL as text with browser-ish headers, retrying transient failures with
 * a linear backoff. Responses are cached only when CACHE_ENABLED is on — in
 * testing mode every call really goes out to the network.
 */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const target = options.bustCache ?? !CACHE_ENABLED ? withCacheBuster(url) : url;

  if (CACHE_ENABLED) {
    const cached = cache.get(target);
    if (cached && cached.expiresAt > Date.now()) {
      log.debug(`cache hit ${target}`);
      return cached.data;
    }
  }

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  if (options.referer) headers["Referer"] = options.referer;
  if (!CACHE_ENABLED) {
    headers["Cache-Control"] = "no-cache, no-store, max-age=0";
    headers["Pragma"] = "no-cache";
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= Math.max(1, HTTP_RETRIES); attempt++) {
    await throttle();
    try {
      const response = await axios.get<string>(target, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        responseType: "text",
        transformResponse: (body) => body, // keep JSON endpoints as raw text
        validateStatus: () => true,
      });

      if (response.status === 429) {
        throw new ScraperRequestError(
          `Rate-limited (HTTP 429) by ${hostOf(target)}. Back off before retrying.`,
          429,
          target
        );
      }
      if (response.status >= 400) {
        throw new ScraperRequestError(
          `${hostOf(target)} returned HTTP ${response.status} for ${target}.`,
          response.status,
          target
        );
      }

      if (CACHE_ENABLED) {
        cache.set(target, { data: response.data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      return response.data;
    } catch (err) {
      lastError = normalizeError(err, target);
      const retriable = attempt < Math.max(1, HTTP_RETRIES);
      log.warn(
        `GET ${target} failed (attempt ${attempt}/${HTTP_RETRIES}): ${(lastError as Error).message}`
      );
      if (!retriable) break;
      await sleep(HTTP_BACKOFF_MS * attempt);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ScraperRequestError(`Could not fetch ${target}`, undefined, target);
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ScraperRequestError(`Expected JSON from ${url} but the response didn't parse.`, undefined, url);
  }
}

export async function fetchDom(url: string, options: FetchOptions = {}): Promise<cheerio.CheerioAPI> {
  return cheerio.load(await fetchText(url, options));
}

function withCacheBuster(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function normalizeError(err: unknown, url: string): Error {
  if (err instanceof ScraperRequestError) return err;
  if (err instanceof AxiosError) {
    if (err.code === "ECONNABORTED") {
      return new ScraperRequestError(`Request to ${url} timed out after ${REQUEST_TIMEOUT_MS}ms.`, undefined, url);
    }
    return new ScraperRequestError(`Network error fetching ${url}: ${err.message}`, err.response?.status, url);
  }
  return err instanceof Error ? err : new Error(String(err));
}
