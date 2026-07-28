#!/usr/bin/env python3
"""Inline a report JSON into report-template.html, producing a self-contained page.

Standalone so the renderer can be exercised without running a review:

    python3 render_report_html.py report.sample.json /tmp/report.html

`code-review-workdir.py write-report` calls inline_report() for the real thing.

Why inline rather than fetch: a `file://` page has an opaque origin, so
`fetch('report.json')` is blocked by every current browser. The previous
template fetched report.md and therefore never worked when the file was opened
directly — only through a local HTTP server.
"""

import json
import sys
from pathlib import Path

PLACEHOLDER_ID = 'id="review-data">'
TEMPLATE = Path(__file__).parent / "report-template.html"


def encode_review_json(report) -> str:
    """Serialise a report for embedding in <script type="application/json">.

    `<` is escaped to its \\u003c form. Findings quote code from the repo under
    review, so a finding containing the characters `</script>` would otherwise
    terminate the data island and let everything after it be parsed as markup.
    JSON string escapes are equivalent to the character, so the parsed value is
    unchanged — only the bytes on the page differ.

    `>` and `&` are escaped for the same family of reasons at no extra cost.
    ensure_ascii keeps the payload 7-bit so it cannot interact with the page's
    declared charset.
    """
    raw = json.dumps(report, ensure_ascii=True, separators=(",", ":"))
    return raw.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def inline_report(report, template_text: str) -> str:
    """Return template_text with the data island replaced by `report`."""
    start = template_text.find(PLACEHOLDER_ID)
    if start == -1:
        raise ValueError("template has no <script id=\"review-data\"> data island")
    start += len(PLACEHOLDER_ID)
    end = template_text.find("</script>", start)
    if end == -1:
        raise ValueError("data island is not closed")
    return template_text[:start] + encode_review_json(report) + template_text[end:]


def main(argv) -> int:
    if len(argv) != 2:
        sys.stderr.write("usage: render_report_html.py <report.json> <out.html>\n")
        return 2
    report = json.loads(Path(argv[0]).read_text())
    out = Path(argv[1])
    out.write_text(inline_report(report, TEMPLATE.read_text()))
    print(str(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
