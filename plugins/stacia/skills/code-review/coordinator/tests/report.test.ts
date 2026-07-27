import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { marked } from "marked";
import createDOMPurify from "dompurify";

/**
 * Replicates report-template.html's render pipeline:
 *   document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(md));
 * against a jsdom window, so we can assert the XSS mitigation without a browser.
 */
function renderReport(md: string): string {
  const window = new JSDOM("").window as unknown as Parameters<typeof createDOMPurify>[0];
  const DOMPurify = createDOMPurify(window);
  return DOMPurify.sanitize(marked.parse(md) as string);
}

describe("report-template render pipeline (marked.parse -> DOMPurify.sanitize)", () => {
  it("strips <script> and on* handlers from attacker-influenced findings text", () => {
    const payload = "# t\n\n<img src=x onerror=alert(1)> and <script>alert(1)</script>";

    const sanitized = renderReport(payload);

    expect(sanitized).not.toMatch(/onerror/i);
    expect(sanitized).not.toMatch(/<script/i);
    expect(sanitized).not.toMatch(/alert\(1\)/);
  });

  it("preserves benign markdown structure (heading survives)", () => {
    const payload = "# t\n\n<img src=x onerror=alert(1)> and <script>alert(1)</script>";

    const sanitized = renderReport(payload);

    expect(sanitized).toMatch(/<h1[^>]*>t<\/h1>/);
  });

  it("preserves an ordinary benign markdown document unchanged in structure", () => {
    const md = "## Findings\n\n- item one\n- item two\n\n**bold** and `code`.";

    const sanitized = renderReport(md);

    expect(sanitized).toContain("<h2");
    expect(sanitized).toContain("Findings");
    expect(sanitized).toContain("<li>item one</li>");
    expect(sanitized).toContain("<strong>bold</strong>");
    expect(sanitized).toContain("<code>code</code>");
  });
});
