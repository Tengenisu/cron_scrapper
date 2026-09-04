import axios, { AxiosError } from "axios";
import { MCP_ENDPOINT, MCP_TIMEOUT_MS } from "../constants.js";
import { McpResponseSchema } from "../schemas/index.js";
import { errorMessage } from "./format.js";
import { log } from "./log.js";

/**
 * A tiny JSON-RPC client for the screener MCP server.
 *
 * The previous implementation shelled out to `node mcp_query.js <SYMBOL>` and
 * re-parsed its stdout; this talks to the endpoint directly, so there is no
 * subprocess, no quoting to survive, and tool errors arrive structurally
 * (`result.isError`) instead of being sniffed out of printed text.
 *
 * Nothing is cached: every request carries no-cache headers and a fresh id, so
 * each run really re-reads the server.
 */

let nextId = 1;

export interface McpCallResult {
  /** false only for a real transport/RPC/tool error — "no data" is still ok. */
  ok: boolean;
  error: string | null;
  /** The tool's text content, joined. */
  text: string;
  /** structuredContent when the tool provided it. */
  structured?: unknown;
  durationMs: number;
}

/**
 * The server may answer a POST either as plain JSON or as an SSE stream
 * (`event: message` / `data: {...}`), depending on the Accept negotiation —
 * both shapes are handled here.
 */
export function parseResponseBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);

  const dataLines = trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  const last = dataLines[dataLines.length - 1];
  if (!last) throw new Error(`unparseable MCP response: ${trimmed.slice(0, 200)}`);
  return JSON.parse(last.slice("data:".length).trim());
}

async function post(payload: Record<string, unknown>): Promise<unknown> {
  const response = await axios.post<string>(MCP_ENDPOINT, payload, {
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      // never serve us a cached answer — this dump must be live every run
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    },
    timeout: MCP_TIMEOUT_MS,
    responseType: "text",
    transformResponse: (raw) => raw,
    validateStatus: () => true,
  });

  if (response.status >= 400) {
    throw new Error(`MCP endpoint returned HTTP ${response.status}: ${String(response.data).slice(0, 200)}`);
  }
  return parseResponseBody(response.data);
}

/** Calls one MCP tool. Never throws — failures come back as `ok: false`. */
export async function callTool(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
  const startedAt = Date.now();
  try {
    const parsed = McpResponseSchema.parse(await post({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }));

    const durationMs = Date.now() - startedAt;

    if (parsed.error) {
      return {
        ok: false,
        error: `RPC ERROR: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
        text: "",
        durationMs,
      };
    }

    const text = (parsed.result?.content ?? [])
      .map((block) => block.text ?? JSON.stringify(block))
      .join("\n")
      .trim();

    if (parsed.result?.isError) {
      return { ok: false, error: text.split("\n")[0] ?? "tool reported an error", text, durationMs };
    }

    return { ok: true, error: null, text, structured: parsed.result?.structuredContent, durationMs };
  } catch (err) {
    const message = err instanceof AxiosError && err.code === "ECONNABORTED"
      ? `timed out after ${MCP_TIMEOUT_MS}ms`
      : errorMessage(err);
    return {
      ok: false,
      error: `REQUEST FAILED: ${message}`,
      text: "",
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Cheap `tools/list` probe. The pipeline runs it before the per-symbol dumps so
 * a dead endpoint is reported once, up front, instead of as N identical
 * connection errors buried in every job.
 */
export async function checkMcpHealth(): Promise<{ ok: boolean; tools: number; error?: string }> {
  try {
    const parsed = McpResponseSchema.parse(await post({ jsonrpc: "2.0", id: nextId++, method: "tools/list" }));
    if (parsed.error) return { ok: false, tools: 0, error: parsed.error.message ?? "tools/list failed" };

    const result = parsed.result as { tools?: unknown[] } | undefined;
    const tools = Array.isArray(result?.tools) ? result.tools.length : 0;
    log.debug(`MCP endpoint ${MCP_ENDPOINT} is healthy (${tools} tools)`);
    return { ok: true, tools };
  } catch (err) {
    return { ok: false, tools: 0, error: errorMessage(err) };
  }
}
