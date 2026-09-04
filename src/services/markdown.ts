import type {
  MarkdownBlock,
  MarkdownDocument,
  MarkdownRow,
  MarkdownSection,
  MarkdownValue,
} from "../types.js";

/**
 * Turns the Markdown an MCP tool returns into JSON.
 *
 * The MCP output has no fixed schema, so this parser is structural rather than
 * field-specific: it walks headings and, under each one, collects tables,
 * `key: value` lines, bullet lists, fenced code blocks and free text. Fenced
 * blocks holding valid JSON are parsed rather than kept as strings.
 */

const HEADING = /^(#{1,6})\s+(.*\S)\s*$/;
const FENCE = /^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const KEYVAL = /^\s*\*{0,2}([A-Za-z0-9][^:*]{0,60}?)\*{0,2}\s*:\s+(.*\S)\s*$/;
/** `**Label:** value` — the colon sits inside the bold markers, so unwrap it first. */
const BOLD_KEY = /^(\s*(?:[-*+]\s+)?)\*\*(.+?)\s*:\s*\*\*\s*/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const NULLISH_CELLS = new Set(["", "-", "--", "—", "–", "N/A", "NA", "null", "None"]);

function unboldKey(line: string): string {
  return line.replace(BOLD_KEY, (_match, indent: string, key: string) => `${indent}${key}: `);
}

function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && (trimmed.match(/\|/g)?.length ?? 0) >= 2;
}

/** Turns obviously numeric cells into numbers and keeps everything else as text. */
export function coerce(value: string): MarkdownValue {
  const trimmed = value.trim();
  if (NULLISH_CELLS.has(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") return lower === "true";

  const cleaned = trimmed.replace(/,/g, "").replace(/%/g, "").replace(/₹/g, "").trim();
  if (/^[+-]?\d+$/.test(cleaned)) return Number.parseInt(cleaned, 10);
  if (/^[+-]?\d*\.\d+$/.test(cleaned)) return Number.parseFloat(cleaned);
  return trimmed;
}

function newSection(title: string | null, level: number): MarkdownSection {
  return { title, level, tables: [], fields: {}, items: [], blocks: [], text: "" };
}

export function markdownToDocument(markdown: string): MarkdownDocument {
  const lines = (markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections: MarkdownSection[] = [];
  let current = newSection(null, 0);
  let textBuffer: string[] = [];

  const flushText = () => {
    current.text = textBuffer.join("\n").trim();
    textBuffer = [];
  };

  let i = 0;
  while (i < lines.length) {
    let line = lines[i] as string;

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // closing fence
      const content = body.join("\n");
      const block: MarkdownBlock = { lang, content };
      try {
        block.data = JSON.parse(content);
      } catch {
        // not JSON — the raw content is kept either way
      }
      current.blocks.push(block);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushText();
      sections.push(current);
      current = newSection(heading[2] ?? null, (heading[1] ?? "").length);
      i++;
      continue;
    }

    const next = lines[i + 1];
    if (isTableRow(line) && next !== undefined && TABLE_SEP.test(next)) {
      const headers = splitRow(line);
      i += 2;
      const rows: MarkdownRow[] = [];
      while (i < lines.length && isTableRow(lines[i] as string)) {
        const cells = splitRow(lines[i] as string);
        const row: MarkdownRow = {};
        headers.forEach((header, index) => {
          row[header || `col${index}`] = coerce(cells[index] ?? "");
        });
        rows.push(row);
        i++;
      }
      current.tables.push(rows);
      continue;
    }

    line = unboldKey(line);

    const bullet = BULLET.exec(line) ?? NUMBERED.exec(line);
    if (bullet) {
      const item = (bullet[1] ?? "").trim();
      const keyval = KEYVAL.exec(item);
      if (keyval) {
        current.fields[(keyval[1] ?? "").trim()] = coerce(keyval[2] ?? "");
      } else if (item) {
        current.items.push(item);
      }
      i++;
      continue;
    }

    const keyval = KEYVAL.exec(line);
    if (keyval && !line.trim().startsWith(">")) {
      current.fields[(keyval[1] ?? "").trim()] = coerce(keyval[2] ?? "");
      i++;
      continue;
    }

    if (line.trim()) textBuffer.push(line.replace(/\s+$/, ""));
    i++;
  }

  flushText();
  sections.push(current);

  const kept = sections.filter(
    (section) =>
      section.title ||
      section.tables.length ||
      Object.keys(section.fields).length ||
      section.items.length ||
      section.blocks.length ||
      section.text
  );

  const fields: Record<string, MarkdownValue> = {};
  const tables: MarkdownRow[][] = [];
  for (const section of kept) {
    Object.assign(fields, section.fields);
    tables.push(...section.tables);
  }

  return { sections: kept, fields, tables, raw: markdown };
}
