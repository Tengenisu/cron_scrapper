import { z } from "zod";

/**
 * Zod lives here for the same reason it does in screener-mcp-server: everything
 * that crosses a boundary — the CLI, Moneycontrol's price feed, the MCP server's
 * JSON-RPC envelope — is validated in one place instead of being trusted.
 */

export const SectionSelectionSchema = z.enum(["both", "calendar", "rapid"]);

export const CliOptionsSchema = z.object({
  mode: z.enum(["once", "cron"]).default("once"),
  section: SectionSelectionSchema.default("both"),
  /** Skip the MCP step entirely — scrape only. */
  enrich: z.boolean().default(true),
  pretty: z.boolean().default(false),
  /** Print just the resolved NSE symbols, one per line. */
  symbolsOnly: z.boolean().default(false),
  /** Run even if another pass is in flight. */
  useLock: z.boolean().default(true),
  /** Also write the JSON document to this path. */
  out: z.string().optional(),
  /** Suppress the JSON document on stdout (the cron writes files instead). */
  quiet: z.boolean().default(false),
});

export type CliOptions = z.infer<typeof CliOptionsSchema>;

/**
 * priceapi.moneycontrol.com/pricefeed/{nse|bse}/equitycash/{scId}.
 * Only NSEID matters here; everything else is passthrough noise.
 */
export const PriceFeedResponseSchema = z.object({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string().optional(),
  data: z
    .object({
      NSEID: z.string().optional(),
      BSEID: z.string().optional(),
      company: z.string().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
});

export type PriceFeedResponse = z.infer<typeof PriceFeedResponseSchema>;

/** A single content block of an MCP tool result. */
export const McpContentBlockSchema = z
  .object({ type: z.string().optional(), text: z.string().optional() })
  .passthrough();

/** The JSON-RPC envelope an MCP `tools/call` comes back in. */
export const McpResponseSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
  error: z
    .object({ code: z.number().optional(), message: z.string().optional() })
    .passthrough()
    .optional(),
  result: z
    .object({
      content: z.array(McpContentBlockSchema).optional(),
      structuredContent: z.unknown().optional(),
      isError: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
});

export type McpResponse = z.infer<typeof McpResponseSchema>;
