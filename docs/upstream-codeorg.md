# Code.org upstream compatibility log

## Reference baseline

- **Upstream:** `droplet-editor/droplet`, branch `code-dot-org`
- **Last reviewed commit:** `482c39f1101631932e6b5b0799c21923c08f79ac`
  (2025-12-17, “Merge pull request #231 from droplet-editor/one-line-for-statement”)
- **Historical Python reference:** PR #187 `text-paste`, commit
  `ce34e2d05580b729c0420153013681f7ba504f68`
- **Review date:** 2026-08-21

The legacy Code.org-derived editor is retained as an executable reference. The
modern editor is a separate implementation; this log records behavior that is
adopted, intentionally diverges, or is rejected.

## Review process

```bash
git fetch upstream
git log main..upstream/code-dot-org
```

Classify each change as a core behavior fix, JavaScript parser fix, Ace-specific
integration, Code.org application behavior, or irrelevant generated output.
For a relevant behavior, add a modern regression test before selectively
reimplementing it. Do not mechanically merge legacy CoffeeScript changes into
modern packages.

## Adopted behavior

| Reference behavior | Status | Evidence |
| --- | --- | --- |
| Code.org JavaScript parse/stringify and block interaction baseline | Preserved in legacy reference | Phase 1 Playwright and QUnit suite |
| Historical Python adapter behavior | Recovered for legacy baseline | Phase 2 Python QUnit corpus |

## Intentional divergence

| Area | Decision | Reason |
| --- | --- | --- |
| Text editor | CodeMirror 6 replaces Ace in the production editor | Modern transaction model and extension ecosystem |
| Production architecture | Source-range core replaces the legacy mutable document model | Exact source preservation and opaque source support |
| Build/distribution | ESM packages replace Grunt/Browserify for the production editor | Current Node support and framework-independent distribution |

## Rejected upstream changes

None recorded yet.
