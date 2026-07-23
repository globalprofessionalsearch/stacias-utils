---
status: accepted
date: 2026-07-23
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review, security]
---

# Report XSS sanitization and CDN script pinning

## Context and Problem Statement

`helper/report-template.html` is a static HTML shell shipped alongside a
generated `report.md`. On load it `fetch`es `report.md` and does:

```js
document.getElementById('content').innerHTML = DOMPurify.sanitize(marked.parse(md));
```

`report.md`'s content is the synthesized findings text produced by the
subagent pipeline (`coordinator.ts`'s synthesis/verifier stages), which is
itself derived from reviewer subagent output over code and diffs the
coordinator does not control the contents of. A malicious or compromised
repo (a crafted filename, commit message, comment, or code snippet a reviewer
subagent quotes verbatim in a finding) can therefore end up embedded in
`report.md` as attacker-influenced text, and it is rendered into the DOM via
`innerHTML`. Markdown alone does not neutralize this: `marked.parse` passes
raw inline HTML (e.g. `<img onerror=...>`, `<script>`) straight through by
design.

Two related risks: (1) the findings text itself needs sanitizing before it
reaches `innerHTML`, and (2) the two `<script>` tags that load `marked` and
`DOMPurify` from `cdn.jsdelivr.net` are themselves a supply-chain trust
boundary — an unpinned `.../marked/marked.min.js` URL serves whatever the
CDN currently has at that path, with no integrity guarantee.

How should we neutralize attacker-influenced findings text before it is
rendered, and how should we trust the CDN-hosted sanitizer/parser that do
that work?

## Decision Drivers

- **No trusted server-side sanitization step exists.** The report is a static
  file pair (`report.html` + `report.md`) with no build/serve step in the
  loop to pre-sanitize `report.md`; sanitization has to happen client-side,
  at render time.
- **Minimize dependency footprint in the shipped extension.** The report
  viewer is a plain HTML file with no bundler; adding a client-side
  dependency should not require a build pipeline for the shipped artifact.
- **CDN scripts are an unpinned, unverified trust boundary today.** The
  original tags (`.../marked/marked.min.js`, `.../dompurify@3/dist/purify.min.js`)
  pin nothing (the marked tag has no version at all) and carry no integrity
  check — a compromised or MITM'd CDN response would execute unmodified.
- **Testability.** The sanitization behavior (does it actually strip
  `<script>`/`on*` handlers while keeping legitimate markdown) must be
  verifiable outside a browser, in CI.

## Considered Options

- **`DOMPurify.sanitize(marked.parse(md))` loaded from a version- and
  integrity-pinned CDN URL (SRI)** (chosen) — sanitize the parsed HTML with a
  battle-tested library; pin both CDN scripts to a specific version with a
  `sha384` Subresource Integrity hash and `crossorigin="anonymous"`.
- **Vendor `marked`/`dompurify` into the extension and ship them alongside
  `report-template.html`** — removes the CDN trust boundary entirely (no
  network fetch, no SRI needed) but adds files to keep in sync with upstream
  security patches and turns a zero-build static HTML file into something
  with a vendored-asset update process; rejected for now in favor of SRI,
  which gets the same integrity guarantee without owning the update
  cadence — revisit if offline/air-gapped report viewing becomes a
  requirement.
- **Unpinned CDN scripts, no SRI (status quo)** — simplest, always gets the
  latest `marked`/`dompurify`, but the CDN response is trusted blindly and
  the `marked` tag had no version pin at all; rejected as the entire point of
  DOMPurify is defense against a compromised input, and an unpinned/unverified
  sanitizer defeats that.
- **Roll a hand-written sanitizer (strip `<script>`/`on*` via regex or a
  small allowlist walker)** — no dependency at all, but HTML-sanitization
  correctness (attribute-based XSS vectors, malformed-HTML parser
  differentials, `javascript:` URLs, etc.) is exactly the kind of thing a
  hand-rolled implementation gets wrong; rejected in favor of a maintained,
  widely-audited library (see also ADR-0004's rationale for hand-rolling only
  a narrow, well-understood subset — full HTML sanitization is not that kind
  of narrow subset).

## Decision Outcome

Chosen option: **`DOMPurify.sanitize(marked.parse(md))`, both loaded from
version- and SRI-pinned jsdelivr URLs**.

`report-template.html`'s two `<script>` tags now pin exact versions
(`marked@14.1.4`, `dompurify@3.4.12`) and each carries
`integrity="sha384-<hash>" crossorigin="anonymous"`, computed via:

```sh
curl -sL <pinned-cdn-url> | openssl dgst -sha384 -binary | openssl base64 -A
```

The render pipeline itself is unchanged: `marked.parse(md)` converts the
findings markdown to HTML, and `DOMPurify.sanitize(...)` strips dangerous
constructs (`<script>`, `on*` event handler attributes, `javascript:` URLs,
etc.) before the result is assigned to `innerHTML`.

`tests/report.test.ts` (vitest + `jsdom` + the `dompurify`/`marked` devDeps)
replicates this exact two-step pipeline against a jsdom `window` and asserts,
for a crafted payload
(`` "# t\n\n<img src=x onerror=alert(1)> and <script>alert(1)</script>" ``),
that the sanitized output contains no `onerror`, no `<script`, and no
`alert(1)`, while the benign `# t` heading still renders as `<h1>t</h1>`.
`jsdom`, `dompurify`, and `marked` are devDependencies only — the shipped
`report-template.html` still loads its runtime copies from the pinned CDN
URLs; nothing in the extension's runtime surface depends on these packages
being installed.

### Consequences

- Good: attacker-influenced findings text (from reviewed repo content quoted
  in findings) can no longer execute script or trigger event-handler-based
  XSS when the report is opened.
- Good: the CDN scripts can no longer silently change out from under the
  report viewer — SRI causes the browser to refuse to execute a script whose
  fetched bytes don't match the pinned hash, whether from a compromised CDN,
  a MITM, or a version bump at an unpinned URL.
- Good: the mitigation is covered by a fast, deterministic, browser-free unit
  test (`report.test.ts`), so a future change to the render pipeline that
  regresses sanitization will fail CI.
- Neutral: report viewing still requires network access to jsdelivr
  (vendoring was considered and rejected above); an offline/air-gapped
  environment cannot render the report today.
- Neutral: bumping `marked`/`dompurify` versions now requires recomputing and
  updating the SRI hash in `report-template.html`, not just editing a version
  string.
- Bad: this protects the report viewer, not the findings pipeline upstream —
  reviewer/synthesis subagent output can still contain attacker-influenced
  text; this ADR only closes the client-side rendering vector, and other
  future consumers of `report.md` are responsible for their own sanitization.

## More Information

- Related: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md),
  [0004-handrolled-schema-subset-validator](0004-handrolled-schema-subset-validator.md)
  (rationale for hand-rolling only a narrow, well-understood validation
  subset — the inverse conclusion applies here, since general HTML
  sanitization is not narrow).
- Pinned CDN URLs (as of this ADR):
  `https://cdn.jsdelivr.net/npm/marked@14.1.4/marked.min.js` and
  `https://cdn.jsdelivr.net/npm/dompurify@3.4.12/dist/purify.min.js`.
