// Local diff rendering utilities.
// Renders diff components using the opentui test renderer, then converts the
// captured frames to HTML for local image/PDF export.

import { exec } from "child_process"
import { promisify } from "util"
import fs from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { getResolvedTheme, rgbaToHex } from "./themes.js"
import { buildDirectoryTree } from "./directory-tree.js"
import type { BoxRenderable, CapturedFrame, CapturedLine, RootRenderable, CliRenderer } from "@opentuah/core"
import { DiffRenderable } from "@opentuah/core"

const execAsync = promisify(exec)

export interface CaptureOptions {
  cols: number
  maxRows: number
  themeName: string
  title?: string
  /** Wrap mode for long lines (default: "word") */
  wrapMode?: "word" | "char" | "none"
  /** Force split or unified view mode, bypassing auto-detection */
  viewMode?: "split" | "unified"
  /** How long to wait for async rendering (tree-sitter) to stabilize.
   *  Default: 500ms for interactive TUI, use 100ms for batch mode. */
  stabilizeMs?: number
}

/**
 * Calculate the actual content height from root's children after layout.
 * Returns the maximum bottom edge (top + height) of all children.
 */
function getContentHeight(root: RootRenderable): number {
  const children = root.getChildren()
  if (children.length === 0) return 0
  
  let maxBottom = 0
  for (const child of children) {
    const layout = child.getLayoutNode().getComputedLayout()
    const bottom = layout.top + layout.height
    if (bottom > maxBottom) {
      maxBottom = bottom
    }
  }
  return Math.ceil(maxBottom)
}

/**
 * Find all DiffRenderable instances in the renderer tree.
 * Walks the tree recursively checking instanceof DiffRenderable.
 */
function findDiffRenderables(root: RootRenderable): InstanceType<typeof DiffRenderable>[] {
  const results: InstanceType<typeof DiffRenderable>[] = []

  function walk(node: { getChildren?: () => any[] }) {
    if (!node.getChildren) return
    for (const child of node.getChildren()) {
      if (child instanceof DiffRenderable) {
        results.push(child)
      }
      walk(child)
    }
  }

  walk(root)
  return results
}

/**
 * Wait for tree-sitter syntax highlighting to complete on all diff elements,
 * then wait for rendering to stabilize (no more requestRender calls).
 *
 * Two-phase approach:
 * 1. Wait for DiffRenderable.isHighlighting to become false on all diffs
 *    (deterministic, exits as soon as tree-sitter is done)
 * 2. Wait for render idle — no new requestRender calls for idleMs
 *    (catches deferred rebuilds like DiffRenderable.requestRebuild which
 *    uses queueMicrotask to schedule buildView + requestRender after
 *    highlighting completes)
 *
 * Phase 2 is critical because DiffRenderable's split view rebuild happens
 * asynchronously via microtask AFTER isHighlighting goes false. Without it,
 * the captured frame may have concealed (unhighlighted) content on one side.
 */
async function waitForHighlightAndRenderStabilization(
  renderer: CliRenderer,
  renderOnce: () => Promise<void>,
  maxMs: number = 2000
): Promise<void> {
  const startTime = Date.now()
  const pollMs = 20
  const idleMs = 80

  // Track render requests to detect when rendering has quiesced
  let lastRenderTime = Date.now()
  const originalRequestRender = renderer.root.requestRender.bind(renderer.root)
  renderer.root.requestRender = function() {
    lastRenderTime = Date.now()
    originalRequestRender()
  }

  // Do one render cycle to kick off highlighting
  await renderOnce()

  // Phase 1: wait for isHighlighting to become false on all diffs
  while (Date.now() - startTime < maxMs) {
    const diffs = findDiffRenderables(renderer.root)
    if (diffs.length === 0 || diffs.every(d => !d.isHighlighting)) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
    await renderOnce()
  }

  // Phase 2: wait for render to stabilize (catches deferred rebuilds)
  // Reset the render timestamp so we wait for any post-highlight renders
  lastRenderTime = Date.now()
  await renderOnce()

  while (Date.now() - startTime < maxMs) {
    const now = Date.now()
    if (now - lastRenderTime >= idleMs) break
    await new Promise(resolve => setTimeout(resolve, pollMs))
    await renderOnce()
  }
}

interface FileSectionPosition {
  lineIndex: number
  fileName: string
  fileIndex: number
}

interface RenderDiffFrameResult {
  frame: CapturedFrame
  sectionPositions: FileSectionPosition[]
  treeFileOrder: number[]
}

/**
 * Render diff to CapturedFrame using opentui test renderer.
 * Uses content-fitting: renders with initial height, measures actual content,
 * then resizes to exact content height to avoid wasting memory.
 */
async function renderDiffToFrameWithSectionPositions(
  diffContent: string,
  options: CaptureOptions,
): Promise<RenderDiffFrameResult> {
  const { createTestRenderer } = await import("@opentuah/core/testing")
  const { createRoot } = await import("@opentuah/react")
  const { getTreeSitterClient } = await import("@opentuah/core")
  const { parsePatch, formatPatch } = await import("diff")
  
  // Pre-initialize TreeSitter client to ensure syntax highlighting works
  const tsClient = getTreeSitterClient()
  await tsClient.initialize()
  
  const { DiffView, DirectoryTreeView } = await import("./components/index.js")
  const {
    getFileName,
    getOldFileName,
    countChanges,
    getFileStatus,
    getViewMode,
    processFiles,
    detectFiletype,
    stripSubmoduleHeaders,
    parseGitDiffFiles,
  } = await import("./diff-utils.js")
  const { themeNames, defaultThemeName } = await import("./themes.js")

  const themeName = options.themeName && themeNames.includes(options.themeName)
    ? options.themeName
    : defaultThemeName

  // Parse the diff (with rename detection support)
  const files = parseGitDiffFiles(stripSubmoduleHeaders(diffContent), parsePatch)
  const filesWithRawDiff = processFiles(files, formatPatch)
  const fileNames = filesWithRawDiff.map((file) => getFileName(file))
  const treeFiles = filesWithRawDiff.map((file, idx) => {
    const { additions, deletions } = countChanges(file.hunks)
    return {
      path: getFileName(file),
      status: getFileStatus(file),
      additions,
      deletions,
      fileIndex: idx,
    }
  })
  const treeFileOrder = buildDirectoryTree(treeFiles)
    .filter((node) => node.isFile && node.fileIndex !== undefined)
    .map((node) => node.fileIndex!)

  if (filesWithRawDiff.length === 0) {
    throw new Error("No files to display")
  }

  // Store refs to each file section container so we can map file headers
  // to exact rendered line indexes (avoids text-regex false positives).
  const fileSectionRefs = new Map<number, BoxRenderable>()

  // Get theme colors
  const webTheme = getResolvedTheme(themeName)
  const webBg = webTheme.background
  const webText = rgbaToHex(webTheme.text)
  const webMuted = rgbaToHex(webTheme.textMuted)

  // Create the diff view component
  // NOTE: No height: "100%" - let content determine its natural height
  function WebApp() {
    return (
      <box
        style={{
          flexDirection: "column",
          backgroundColor: webBg,
        }}
      >
        <box style={{ marginBottom: 2 }}>
          <DirectoryTreeView files={treeFiles} themeName={themeName} />
        </box>

        {filesWithRawDiff.map((file, idx) => {
          const fileName = getFileName(file)
          const oldFileName = getOldFileName(file)
          const filetype = detectFiletype(fileName)
          const { additions, deletions } = countChanges(file.hunks)
          // Use forced viewMode if set, otherwise auto-detect (higher threshold 150 for web vs TUI 100)
          const viewMode = options.viewMode || getViewMode(additions, deletions, options.cols, 150)

          return (
            <box
              key={idx}
              ref={(r: BoxRenderable | null) => {
                if (r) fileSectionRefs.set(idx, r)
                else fileSectionRefs.delete(idx)
              }}
              style={{ flexDirection: "column", marginBottom: 2 }}
            >
              <box
                style={{
                  paddingBottom: 1,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexShrink: 0,
                  flexDirection: "row",
                  alignItems: "center",
                }}
              >
                {oldFileName ? (
                  <>
                    <text fg={webMuted}>{oldFileName.trim()}</text>
                    <text fg={webMuted}> → </text>
                    <text fg={webText}>{fileName.trim()}</text>
                  </>
                ) : (
                  <text fg={webText}>{fileName.trim()}</text>
                )}
                <text fg="#2d8a47"> +{additions}</text>
                <text fg="#c53b53">-{deletions}</text>
              </box>

              <DiffView
                diff={file.rawDiff || ""}
                view={viewMode}
                filetype={filetype}
                themeName={themeName}
                wrapMode={options.wrapMode}
              />
            </box>
          )
        })}
      </box>
    )
  }

  // Content-fitting rendering:
  // 1. Start with small initial height
  // 2. If content is clipped (content height == buffer height), double the buffer
  // 3. Repeat until content fits or we hit max
  // 4. Shrink to exact content height
  
  let currentHeight = 100 // Start small
  
  const { renderer, renderOnce, resize } = await createTestRenderer({
    width: options.cols,
    height: currentHeight,
  })

  // Mount and do initial render
  createRoot(renderer).render(<WebApp />)
  await renderOnce()
  
  // Wait for React to mount components (may take a few render cycles)
  let contentHeight = getContentHeight(renderer.root)
  while (contentHeight === 0) {
    await new Promise(resolve => setTimeout(resolve, 10))
    await renderOnce()
    contentHeight = getContentHeight(renderer.root)
  }
  
  // If content height == buffer height, content is clipped - double until it fits
  while (contentHeight >= currentHeight && currentHeight < options.maxRows) {
    currentHeight = Math.min(currentHeight * 2, options.maxRows)
    resize(options.cols, currentHeight)
    await renderOnce()
    contentHeight = getContentHeight(renderer.root)
  }
  
  // Shrink to exact content height (remove empty space at bottom)
  const finalHeight = Math.min(Math.max(contentHeight, 1), options.maxRows)
  if (finalHeight < renderer.height) {
    resize(options.cols, finalHeight)
    await renderOnce()
  }
  
  // Wait for tree-sitter highlighting + render stabilization
  await waitForHighlightAndRenderStabilization(renderer, renderOnce, options.stabilizeMs ?? 2000)

  const sectionPositions: FileSectionPosition[] = []
  for (let idx = 0; idx < fileNames.length; idx++) {
    const section = fileSectionRefs.get(idx)
    if (!section) continue

    const layout = section.getLayoutNode().getComputedLayout()
    sectionPositions.push({
      lineIndex: Math.max(0, Math.round(layout.top)),
      fileName: fileNames[idx]!,
      fileIndex: idx,
    })
  }

  // Capture the final frame
  const buffer = renderer.currentRenderBuffer
  const cursorState = renderer.getCursorState()
  const frame: CapturedFrame = {
    cols: buffer.width,
    rows: buffer.height,
    cursor: [cursorState.x, cursorState.y],
    lines: buffer.getSpanLines(),
  }
  
  renderer.destroy()
  return {
    frame,
    sectionPositions,
    treeFileOrder,
  }
}

export async function renderDiffToFrame(
  diffContent: string,
  options: CaptureOptions,
): Promise<CapturedFrame> {
  const { frame } = await renderDiffToFrameWithSectionPositions(diffContent, options)
  return frame
}

/**
 * Convert a file path to a URL-safe anchor slug.
 * e.g. "src/components/foo-bar.tsx" → "src-components-foo-bar-tsx"
 */
export function slugifyFileName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

/**
 * Return a unique ID, appending -2, -3, etc. if the base already exists.
 */
function dedupeId(id: string, usedIds: Set<string>): string {
  if (!usedIds.has(id)) return id
  let i = 2
  while (usedIds.has(`${id}-${i}`)) i++
  return `${id}-${i}`
}

/**
 * Extract line numbers from a captured diff line's spans.
 * In split view each row has two line number columns (old + new):
 *   " " "29" " - " ...content... " " "29" " + " ...content...
 * In unified view there's only one.
 *
 * Returns the new-file (right) line number when available,
 * falling back to the old-file (left) number for deleted-only rows.
 * Returns null for non-diff lines (headers, hunk markers, etc.).
 */
export function extractLineNumber(line: CapturedLine): string | null {
  let firstNum: string | null = null
  let secondNum: string | null = null
  let foundNonEmpty = false

  for (const span of line.spans) {
    const trimmed = span.text.trim()
    if (trimmed === "") continue

    if (/^\d+$/.test(trimmed)) {
      if (!firstNum) {
        firstNum = trimmed
      } else if (!secondNum) {
        secondNum = trimmed
      }
    } else if (!foundNonEmpty) {
      // First non-empty span is not a number — not a diff line
      return null
    }
    foundNonEmpty = true
  }

  // Prefer new-file (right/second) number; fall back to old-file (left/first)
  return secondNum ?? firstNum
}

/**
 * Match a rendered tree file row and extract the file path label.
 * Examples:
 *   "│   ├── index.ts (+5,-2)"
 *   "└── README.md (-15)"
 */
export function extractTreeFilePath(lineText: string): string | null {
  const match = lineText.match(/^\s*[│ ]*[├└]──\s+(.+?)\s+\([^)]*\)\s*$/)
  if (!match || !match[1]) return null
  return match[1].trim()
}

/**
 * Build line-indexed anchors from file section layout positions.
 * This avoids regex detection on rendered text, which can produce
 * false positives when code lines mimic file-header patterns.
 */
export function buildAnchorMap(
  sections: Array<{ lineIndex: number; fileName: string }>,
): Map<number, { id: string; label: string }> {
  const anchors = new Map<number, { id: string; label: string }>()
  const usedIds = new Set<string>()

  for (const section of sections) {
    if (!Number.isFinite(section.lineIndex) || section.lineIndex < 0) continue
    if (anchors.has(section.lineIndex)) continue

    const label = section.fileName.trim()
    const baseSlug = slugifyFileName(label) || "file"
    const id = dedupeId(baseSlug, usedIds)
    usedIds.add(id)
    anchors.set(section.lineIndex, { id, label })
  }

  return anchors
}

/**
 * Open a URL in the default browser
 */
export async function openInBrowser(url: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      await execAsync(`open "${url}"`)
    } else if (process.platform === "win32") {
      // On Windows, `start` treats the first quoted arg as a window title,
      // so pass an empty title before the URL
      await execAsync(`cmd /c start "" "${url}"`)
    } else {
      await execAsync(`xdg-open "${url}"`)
    }
  } catch {
    // Silent fail - user can copy URL manually
  }
}

/**
 * Write content to a temp file and return the path
 */
export function writeTempFile(content: string, prefix: string, ext: string): string {
  const filePath = join(tmpdir(), `${prefix}-${Date.now()}${ext}`)
  fs.writeFileSync(filePath, content)
  return filePath
}

/**
 * Clean up a temp file (ignores errors)
 */
export function cleanupTempFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Ignore cleanup errors
  }
}
