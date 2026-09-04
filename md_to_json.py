"""Convert the Markdown returned by the MCP node query into JSON.

The MCP output is not a fixed schema, so this parser is structural rather than
field-specific: it walks headings, and under each heading collects tables,
`key: value` lines, bullet lists, fenced code blocks and free text. Fenced
blocks that contain valid JSON are parsed rather than kept as strings.

Shape produced for a document::

    {
      "sections": [
        {"title": "Quote", "level": 2,
         "tables": [[{"col": "val"}, ...]],
         "fields": {"Symbol": "DHOOTTRANS"},
         "items": ["bullet one"],
         "blocks": [{"lang": "json", "data": {...}}],
         "text": "leftover prose"}
      ],
      "fields": {...},      # merged fields from every section
      "tables": [...],      # every table, flattened
      "raw": "<the markdown>"
    }
"""
from __future__ import annotations

import json
import re

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
_FENCE = re.compile(r"^\s*```+\s*([A-Za-z0-9_+-]*)\s*$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*\d+[.)]\s+(.*)$")
_KEYVAL = re.compile(r"^\s*\*{0,2}([A-Za-z0-9][^:*]{0,60}?)\*{0,2}\s*:\s+(.*\S)\s*$")
# `**Label:** value` -- the colon sits inside the bold markers, so unwrap it first.
_BOLD_KEY = re.compile(r"^(\s*(?:[-*+]\s+)?)\*\*(.+?)\s*:\s*\*\*\s*")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _unbold_key(line: str) -> str:
    return _BOLD_KEY.sub(lambda m: m.group(1) + m.group(2) + ": ", line)


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return [c.strip() for c in line.split("|")]


def _is_table_row(line: str) -> bool:
    return line.strip().startswith("|") and line.count("|") >= 2


def _coerce(value: str):
    """Turn obviously numeric cells into numbers, keep everything else as text."""
    v = value.strip()
    if v in {"", "-", "--", "N/A", "NA", "null", "None"}:
        return None
    low = v.lower()
    if low in {"true", "false"}:
        return low == "true"
    cleaned = v.replace(",", "").replace("%", "").replace("₹", "").strip()
    if re.fullmatch(r"[+-]?\d+", cleaned):
        return int(cleaned)
    if re.fullmatch(r"[+-]?\d*\.\d+", cleaned):
        return float(cleaned)
    return v


def _new_section(title: str | None, level: int) -> dict:
    return {
        "title": title,
        "level": level,
        "tables": [],
        "fields": {},
        "items": [],
        "blocks": [],
        "text": "",
    }


def markdown_to_dict(markdown: str) -> dict:
    lines = (markdown or "").replace("\r\n", "\n").split("\n")
    sections: list[dict] = []
    current = _new_section(None, 0)
    text_buf: list[str] = []

    def flush_text() -> None:
        current["text"] = "\n".join(text_buf).strip()
        text_buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i]

        fence = _FENCE.match(line)
        if fence:
            lang = fence.group(1) or ""
            body: list[str] = []
            i += 1
            while i < len(lines) and not _FENCE.match(lines[i]):
                body.append(lines[i])
                i += 1
            i += 1
            content = "\n".join(body)
            block = {"lang": lang, "content": content}
            try:
                block["data"] = json.loads(content)
            except (ValueError, TypeError):
                pass
            current["blocks"].append(block)
            continue

        heading = _HEADING.match(line)
        if heading:
            flush_text()
            sections.append(current)
            current = _new_section(heading.group(2), len(heading.group(1)))
            i += 1
            continue

        if _is_table_row(line) and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            headers = _split_row(line)
            i += 2
            rows = []
            while i < len(lines) and _is_table_row(lines[i]):
                cells = _split_row(lines[i])
                cells += [""] * (len(headers) - len(cells))
                rows.append({h or f"col{n}": _coerce(c) for n, (h, c) in enumerate(zip(headers, cells))})
                i += 1
            current["tables"].append(rows)
            continue

        line = _unbold_key(line)

        bullet = _BULLET.match(line) or _NUMBERED.match(line)
        if bullet:
            item = bullet.group(1).strip()
            kv = _KEYVAL.match(item)
            if kv:
                current["fields"][kv.group(1).strip()] = _coerce(kv.group(2))
            else:
                current["items"].append(item)
            i += 1
            continue

        kv = _KEYVAL.match(line)
        if kv and not line.strip().startswith(">"):
            current["fields"][kv.group(1).strip()] = _coerce(kv.group(2))
            i += 1
            continue

        if line.strip():
            text_buf.append(line.rstrip())
        i += 1

    flush_text()
    sections.append(current)

    sections = [
        s for s in sections
        if s["title"] or s["tables"] or s["fields"] or s["items"] or s["blocks"] or s["text"]
    ]

    merged_fields: dict = {}
    all_tables: list = []
    for s in sections:
        merged_fields.update(s["fields"])
        all_tables.extend(s["tables"])

    return {
        "sections": sections,
        "fields": merged_fields,
        "tables": all_tables,
        "raw": markdown,
    }
