---
status: accepted
date: 2026-07-23
decision-makers: Stacia Colasurdo
jeenius-tags: [architecture, code-review]
---

# TypeScript coordinator / Python helper contract

## Context and Problem Statement

`stacia-code-review` splits responsibility across two languages. The TS
extension (`extensions/stacia-code-review/{assets,coordinator,index}.ts`)
orchestrates subagents and never touches diff bytes or filesystem paths
directly. `extensions/stacia-code-review/helper/code-review-workdir.py` is a
private, non-PATH helper that owns every path, mkdir, and write for a run: it
captures diffs (`gh`/`git`), builds bundles, and persists
context/findings/report.

Because the two sides run as separate processes (`assets.ts` spawns
`python3 code-review-workdir.py ...` via `execFile`), there is no shared type
system between them. The only contract is: the JSON shape of `manifest.json`,
the CLI subcommands, their argument/stdin conventions, and the slug rules used
to route `write-findings`. Nothing enforces this at compile time — it is a
convention that both files must keep in sync by hand.

What should this cross-language contract be, and how should we manage the
drift risk between two processes with no shared type checker?

## Decision Drivers

- The orchestrating model must never handle raw diff bytes or filesystem
  paths directly — that responsibility must stay isolated in the helper.
- The two files run as separate processes in separate languages, so there is
  no compiler to catch drift between them.
- A specific data-loss risk exists: a repo slug colliding with the reserved
  `"synthesis"` slug would silently overwrite the synthesis findings file.

## Considered Options

- Define and document a manifest/CLI/slug contract that both files must
  mirror by hand, in the same commit, on any change (chosen).
- Shared schema/IDL (e.g. JSON Schema or protobuf) generating both sides.
- Reimplement the helper in TS, dropping the subprocess boundary.
- Do nothing; treat drift risk as acceptable.

## Decision Outcome

Chosen option: treat the manifest shape, CLI surface, and slug-routing rules
below as one cross-language contract; a change to either side requires a
mirrored change on the other, in the same commit.

**Manifest shape** (`manifest.json`, written by `init`, read by every other
subcommand and by TS's `Manifest`/`RepoRef` interfaces in `assets.ts`):
- `run_dir`, `report`, `report_html`, `multi_repo`
- `repos: [{repo, slug, bundle, findings}]`
- `context: [{id, kind, title, path}]`

**CLI surface** (`code-review-workdir.py` subcommands, called from
`assets.ts`'s `runHelper` wrappers — `initRun`, `buildBundle`, `addContext`,
`writeFindings`, `writeReport`):
- `init <repo>... [--label L]` → prints manifest JSON on stdout
- `build-bundle --run --slug --repo-path --source` → prints bundle path
- `add-context --run --kind --id --title [--ext]` (body on stdin) → prints
  staged path; TS then appends the returned entry to its in-memory
  `manifest.context` (`index.ts`)
- `write-findings --run --slug` (JSON on stdin) → prints written path
- `write-report --run` (markdown on stdin) → prints report (and
  `report_html`) path

**Slug routing.** `unique_slugs` (Python) slugifies each repo's basename and
disambiguates collisions by suffixing `-N`. `"synthesis"` is a
`RESERVED_SLUGS` entry: `write-findings` treats a repo-matching slug as a
per-repo write (`findings/<slug>.json` from the manifest) and any other slug,
including `"synthesis"`, as a top-level write to `findings/<slug>.json` under
the run dir. A repo whose basename slugifies to `"synthesis"` is
force-disambiguated in `unique_slugs` so it can never collide with that
reserved path. The TS side's only counterpart is `index.ts` calling
`writeFindings(assets.helper, manifest.run_dir, "synthesis", ...)` for the
overall synthesis result — it relies on, but does not itself implement, the
reservation.

Rejected alternatives:
- **Shared schema/IDL (e.g. JSON Schema or protobuf) generating both sides**:
  disproportionate for a two-file, single-maintainer contract; would add
  build tooling for marginal safety gain.
- **Reimplement the helper in TS, drop the subprocess boundary**: the
  helper's job (owning paths/mkdir/diff capture so the orchestrating model
  never handles raw diff bytes or filesystem paths) is intentionally isolated
  from the LLM-orchestration code; keeping it a separate process in a
  separate language reinforces that boundary rather than blurring it.
- **Do nothing, treat drift risk as acceptable**: the reserved-slug rule
  specifically exists to prevent a silent data-loss bug (a repo overwriting
  the synthesis findings file), which is exactly the kind of cross-language
  assumption that needs to be written down.

### Consequences

- Good: the helper's isolation is preserved — the orchestrating model never
  handles raw diff bytes or filesystem paths.
- Good: the reserved-slug rule prevents a specific silent data-loss bug (a
  repo overwriting the synthesis findings file).
- Bad: the two files can be edited by different people/languages without a
  shared type checker catching drift; reviewers must check both when either
  changes.
- Bad: adding a new subcommand, manifest field, or reserved slug means
  updating: the Python `argparse` subparser + handler, the corresponding TS
  wrapper in `assets.ts`, the `Manifest`/`RepoRef` TS interfaces if the shape
  changed, and any caller in `coordinator.ts`/`index.ts`.
- Bad: `RESERVED_SLUGS` must stay a superset of every fixed (non-repo) slug
  the TS side writes to (currently only `"synthesis"`). Adding a new fixed
  TS-side slug without adding it to `RESERVED_SLUGS` reintroduces the
  collision risk this ADR documents.
- Neutral/Bad: `RESERVED_SLUGS` is a **behavior change, not a pure port** of
  slug handling — a repo whose basename literally slugifies to `"synthesis"`
  no longer gets its own `findings/synthesis.json`; `unique_slugs` now
  force-disambiguates it (e.g. to `synthesis-1`) so the reserved top-level
  slug always resolves to the overall synthesis output. Anyone reviewing a
  repo actually named `synthesis` will see its findings under a suffixed
  slug, not the bare one — worth calling out explicitly since it's easy to
  read this as a no-op rename-avoidance tweak rather than a routing change.
- Neutral: no schema validation ties the two together (`_write_json` only
  checks the findings payload is valid JSON, not that it matches
  `reviewer-output` / `synthesis` schemas); schema conformance is enforced
  separately on the TS side (`assets.schemas.*`, `injectBounds`, backed by
  config/personas/schemas under `extensions/stacia-code-review/assets/`) —
  see [0004-handrolled-schema-subset-validator](0004-handrolled-schema-subset-validator.md).

## More Information

- Related: [0001-orchestration-migration-to-custom-extension](0001-orchestration-migration-to-custom-extension.md),
  [0004-handrolled-schema-subset-validator](0004-handrolled-schema-subset-validator.md).
