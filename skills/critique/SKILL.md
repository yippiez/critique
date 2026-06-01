---
name: critique
description: >
  Git diff viewer. Renders diffs in a terminal TUI and exports them as
  images and PDFs with syntax highlighting. Use this skill when working with
  critique for showing diffs, exporting them, or selective hunk staging.
---

# critique

Git diff viewer that renders diffs in a terminal TUI and exports them as **images** and **PDFs** with syntax highlighting.

**Always run `critique --help` first** to see the latest flags and commands. The help output is the source of truth.

## PDF

```bash
critique --pdf                              # working tree to PDF
critique --staged --pdf                     # staged changes
critique main...HEAD --pdf                   # branch diff
critique --commit HEAD --pdf                # single commit
critique --pdf output.pdf                   # custom filename
critique --pdf --pdf-page-size a4-portrait  # page size options
critique main...HEAD --pdf --open            # open in viewer
```

## Image

```bash
critique --image              # renders to /tmp as WebP
critique main...HEAD --image  # branch diff as images
```

## Selective hunk staging

When multiple agents work on the same repo, each agent should only commit its own changes. `critique hunks` lets you stage individual hunks instead of whole files — like a scriptable `git add -p`.

```bash
# List hunks with stable IDs
critique hunks list
critique hunks list --filter "src/**/*.ts"

# Stage specific hunks by ID
critique hunks add 'src/main.ts:@-10,6+10,7'
critique hunks add 'src/main.ts:@-10,6+10,7' 'src/utils.ts:@-5,3+5,4'
```

Hunk ID format: `file:@-oldStart,oldLines+newStart,newLines` — derived from the `@@` diff header, stable across runs.

**Typical workflow:**

```bash
critique hunks list                          # see all unstaged hunks
critique hunks add 'file:@-10,6+10,7'       # stage only your hunks
git commit -m "your changes"                 # commit separately
```

## Notes

- Requires **Bun** — use `bunx critique` or global `critique`
- Lock files and diffs >6000 lines are auto-hidden
