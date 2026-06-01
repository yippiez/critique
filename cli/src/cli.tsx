#!/usr/bin/env bun
// CLI entrypoint for the critique diff viewer.
// Provides TUI diff viewing, selective hunk staging, and local image/PDF export.
// Commands: default (diff), hunks (list/add), difftool, pick (cherry-pick files).

// Must be first import: patches process.stdout.columns/rows for Bun compiled binaries
// where they incorrectly return 0 instead of actual terminal dimensions.
import "./patch-terminal-dimensions.js";

import { goke, wrapJsonSchema } from "goke";
import {
  createRoot,
  flushSync,
  useKeyboard,
  useOnResize,
  useRenderer,
  useTerminalDimensions,
} from "@opentuah/react";
import { useCopySelection } from "./hooks/use-copy-selection.js";
import * as React from "react";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import {
  createCliRenderer,
  MacOSScrollAccel,
  ScrollBoxRenderable,
  BoxRenderable,
  addDefaultParsers,
} from "@opentuah/core";
import parsersConfig from "./parsers-config.js";

// Register custom syntax highlighting parsers
addDefaultParsers(parsersConfig.parsers);
import stripAnsi from "strip-ansi";
import fs from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { create } from "zustand";
import Dropdown from "./dropdown.js";
import { debounce } from "./utils.js";
import { DiffView, DirectoryTreeView } from "./components/index.js";
import { logger } from "./logger.js";
import {
  buildGitCommand,
  ensureGitRepo,
  filterParsedFilesByPatterns,
  getFileName,
  getFileStatus,
  getOldFileName,
  countChanges,
  getViewMode,
  processFiles,
  detectFiletype,
  stripSubmoduleHeaders,
  parseGitDiffFiles,
  getDirtySubmodulePaths,
  buildSubmoduleDiffCommand,
  getFilterPatterns,
  IGNORED_FILES,
  type ParsedFile,
  type GitCommandOptions,
} from "./diff-utils.js";
import type { TreeFileInfo } from "./directory-tree.js";
import packageJson from "../package.json" assert { type: "json" };


// Lazy-load watcher only when --watch is used
let watcherModule: typeof import("@parcel/watcher") | null = null;
async function getWatcher() {
  if (!watcherModule) {
    watcherModule = await import("@parcel/watcher");
  }
  return watcherModule;
}
import {
  getSyntaxTheme,
  getResolvedTheme,
  themeNames,
  defaultThemeName,
  rgbaToHex,
} from "./themes.js";
import {
  useAppStore,
  persistedState,
} from "./store.js";


// PDF mode handler - receives already-cleaned diff content
interface PdfModeOptions {
  filename?: string;
  open?: boolean;
  theme?: string;
  cols?: number;
  /** Page size preset or custom WxH in points (default: "a4-landscape") */
  pageSize?: string;
}

/** Standard page size presets in points [width, height] */
const PAGE_SIZE_PRESETS: Record<string, [number, number]> = {
  "a4-landscape": [842, 595],
  "a4-portrait": [595, 842],
  "a3-landscape": [1191, 842],
  "a3-portrait": [842, 1191],
  "letter-landscape": [792, 612],
  "letter-portrait": [612, 792],
  "legal-landscape": [1008, 612],
  "legal-portrait": [612, 1008],
}

/**
 * Parse a page size string into [width, height] in points.
 * Accepts presets like "a4-landscape" or custom "WxH" (e.g. "1000x600").
 */
function parsePageSize(size: string): [number, number] {
  const preset = PAGE_SIZE_PRESETS[size.toLowerCase()]
  if (preset) return preset

  // Try custom WxH format
  const match = size.match(/^(\d+)x(\d+)$/i)
  if (match) {
    return [parseInt(match[1]!, 10), parseInt(match[2]!, 10)]
  }

  throw new Error(
    `Invalid page size "${size}". Use a preset (${Object.keys(PAGE_SIZE_PRESETS).join(", ")}) or custom WxH (e.g. 1000x600)`
  )
}

async function runPdfMode(
  diffContent: string,
  options: PdfModeOptions
) {
  const { renderDiffToFrame } = await import("./web-utils.js");
  const { renderFrameToPdf } = await import("./opentui-pdf.js");
  const { join } = await import("path");
  const { tmpdir } = await import("os");

  // PDF defaults to github-light (better for print/reading), but respects --theme
  const themeName = options.theme && themeNames.includes(options.theme)
    ? options.theme
    : "github-light";

  // Parse page size (default: a4-landscape for more horizontal space)
  const [pageWidth, pageHeight] = parsePageSize(options.pageSize || "a4-landscape");
  // Landscape default uses more cols for split diff; portrait keeps old default
  const cols = options.cols || (pageWidth > pageHeight ? 200 : 140);

  console.log("Rendering to PDF...");

  try {
    // Capture frame using opentui test renderer
    // Force split view for landscape pages (enough horizontal space)
    const frame = await renderDiffToFrame(diffContent, {
      cols,
      maxRows: 10000,
      themeName,
      viewMode: pageWidth > pageHeight ? "split" : undefined,
    });

    // Resolve theme colors
    const theme = getResolvedTheme(themeName);

    // Resolve font path (shipped .ttf in public/)
    const fontPath = join(import.meta.dir, "..", "public", "jetbrains-mono-nerd.ttf");

    const result = await renderFrameToPdf(frame, {
      pageWidth,
      pageHeight,
      theme: {
        background: rgbaToHex(theme.background),
        text: rgbaToHex(theme.text),
      },
      fontPath,
    });

    const outPath = options.filename || join(tmpdir(), `critique-diff-${Date.now()}.pdf`);
    fs.writeFileSync(outPath, result.buffer);
    console.log(`\nPDF written: ${outPath}`);
    console.log(`${result.pageCount} page${result.pageCount === 1 ? "" : "s"}, ${result.totalLines} lines`);

    if (options.open) {
      const { openInBrowser } = await import("./web-utils.js");
      await openInBrowser(outPath);
    }

    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to generate PDF:", message);
    process.exit(1);
  }
}

// Image mode handler - receives already-cleaned diff content
interface ImageModeOptions {
  theme?: string;
  cols?: number;
}

async function runImageMode(
  diffContent: string,
  options: ImageModeOptions
) {
  const { renderDiffToImages } = await import("./image.js");

  const themeName = options.theme && themeNames.includes(options.theme)
    ? options.theme
    : persistedState.themeName ?? defaultThemeName;

  const cols = options.cols || 120;

  console.log("Rendering to images...");

  try {
    const result = await renderDiffToImages(diffContent, {
      cols,
      themeName,
    });

    console.log(`\nGenerated ${result.imageCount} image${result.imageCount === 1 ? "" : "s"}:`);
    for (const path of result.paths) {
      console.log(`  ${path}`);
    }

    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to generate images:", message);
    process.exit(1);
  }
}

// Scrollback mode handler - outputs ANSI to stdout instead of interactive TUI
interface ScrollbackModeOptions {
  cols?: number;
  theme?: string;
}

async function runScrollbackMode(
  diffContent: string,
  options: ScrollbackModeOptions
) {
  const { renderDiffToFrame } = await import("./web-utils.js");
  const { frameToAnsi } = await import("./ansi-output.js");
  const { getResolvedTheme } = await import("./themes.js");

  const themeName = options.theme && themeNames.includes(options.theme)
    ? options.theme
    : persistedState.themeName ?? defaultThemeName;

  const cols = options.cols || process.stdout.columns || 120;

  try {
    const frame = await renderDiffToFrame(diffContent, {
      cols,
      maxRows: 10000,
      themeName,
    });

    const theme = getResolvedTheme(themeName);
    const ansi = frameToAnsi(frame, theme.background);

    process.stdout.write(ansi + "\n");
    process.exit(0);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Failed to render scrollback:", message);
    process.exit(1);
  }
}

// Error boundary component
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  declare props: ErrorBoundaryProps;

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch = (error: Error, errorInfo: React.ErrorInfo): void => {
    logger.log("Error caught by boundary:", error);
    logger.log("Component stack:", errorInfo.componentStack);
  };

  render(): React.ReactNode {
    if (this.state.hasError && this.state.error) {
      return (
        <box style={{ flexDirection: "column", padding: 2 }}>
          <text fg="red">Error: {this.state.error.message}</text>
          <text fg="brightBlack">{this.state.error.stack}</text>
        </box>
      );
    }
    return this.props.children;
  }
}

const execAsync = promisify(exec);

async function filterCombinedDiffByPatterns(
  diffContent: string,
  options: Pick<GitCommandOptions, "filter" | "positionalFilters">,
): Promise<string> {
  if (!diffContent.trim()) return diffContent;
  if (getFilterPatterns(options).length === 0) return diffContent;

  const { parsePatch, formatPatch } = await import("diff");
  const parsedFiles = parseGitDiffFiles(stripSubmoduleHeaders(diffContent), parsePatch);
  const filteredFiles = filterParsedFilesByPatterns(parsedFiles, options);

  if (filteredFiles.length === 0) return "";

  return filteredFiles.map((file) => formatPatch(file)).join("\n");
}

function formatPreviewExpiry(expiresInDays?: number | null): string {
  if (expiresInDays === null) {
    return "(never expires)";
  }
  if (typeof expiresInDays === "number") {
    return `(expires in ${expiresInDays} days)`;
  }
  return "(expires in 7 days)";
}





function execSyncWithError(
  command: string,
  options?: any,
): { data?: any; error?: string } {
  try {
    const data = execSync(command, options);
    return { data };
  } catch (error: any) {
    const stderr = error.stderr?.toString() || error.message || String(error);
    return { error: stderr };
  }
}

const cli = goke("critique");

class ScrollAcceleration {
  public multiplier: number = 1;
  private macosAccel: MacOSScrollAccel;
  constructor() {
    this.macosAccel = new MacOSScrollAccel({ A: 1.5, maxMultiplier: 10 });
  }
  tick(delta: number) {
    return this.macosAccel.tick(delta) * this.multiplier;
  }
  reset() {
    this.macosAccel.reset();
    // this.multiplier = 1;
  }
}

export interface AppProps {
  parsedFiles: ParsedFile[];
}

// Rows reserved for the footer + outer padding, subtracted from the terminal
// height when sizing the bottom scroll spacer. Fallback used before the renderer
// reports its height.
const FOOTER_RESERVED_ROWS = 4;
const FALLBACK_TERMINAL_ROWS = 24;

export function App({ parsedFiles }: AppProps): React.ReactElement {
  const { width: initialWidth } = useTerminalDimensions();
  const [width, setWidth] = React.useState(initialWidth);
  const [scrollAcceleration] = React.useState(() => new ScrollAcceleration());
  const themeName = useAppStore((s) => s.themeName);
  const [showDropdown, setShowDropdown] = React.useState(false);
  const [showThemePicker, setShowThemePicker] = React.useState(false);
  const [previewTheme, setPreviewTheme] = React.useState<string | null>(null);

  // Refs for scroll-to-file functionality
  const scrollboxRef = React.useRef<ScrollBoxRenderable | null>(null);
  const fileRefs = React.useRef<Map<number, BoxRenderable>>(new Map());

  // Ref for double-tap detection (gg)
  const lastKeyRef = React.useRef<{ key: string; time: number } | null>(null);

  // Copy selection to clipboard as soon as the selection settles, then
  // deselect and surface a confirmation toast in the footer.
  const [copyToast, setCopyToast] = React.useState<string | null>(null);
  const copyToastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showCopyToast = React.useCallback(() => {
    setCopyToast("Copied to clipboard");
    if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    copyToastTimerRef.current = setTimeout(() => setCopyToast(null), 1200);
  }, []);
  React.useEffect(
    () => () => {
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current);
    },
    [],
  );
  const { onMouseUp, onMouseDown } = useCopySelection({ onCopied: showCopyToast });

  useOnResize(
    React.useCallback((newWidth: number) => {
      setWidth(newWidth);
    }, []),
  );

  const renderer = useRenderer();

  useKeyboard((key) => {
    if (showDropdown || showThemePicker) {
      if (key.name === "escape") {
        setShowDropdown(false);
        setShowThemePicker(false);
        setPreviewTheme(null);
      }
      return;
    }

    if (key.name === "escape" || key.name === "q") {
      renderer.destroy();
      return;
    }

    if (key.name === "p") {
      setShowDropdown(true);
      return;
    }

    if (key.name === "t") {
      setShowThemePicker(true);
      return;
    }

    if (key.name === "z" && key.ctrl) {
      renderer.console.toggle();
      return;
    }

    // Vim-style scroll navigation
    const scrollbox = scrollboxRef.current;
    if (scrollbox) {
      // G - go to bottom
      if (key.name === "g" && key.shift) {
        scrollbox.scrollBy(1, "content");
        return;
      }

      // gg - go to top (double-tap within 300ms)
      if (key.name === "g" && !key.shift && !key.ctrl) {
        const now = Date.now();
        if (lastKeyRef.current?.key === "g" && now - lastKeyRef.current.time < 300) {
          scrollbox.scrollTo(0);
          lastKeyRef.current = null;
        } else {
          lastKeyRef.current = { key: "g", time: now };
        }
        return;
      }

      // Ctrl+D - half page down
      if (key.ctrl && key.name === "d") {
        scrollbox.scrollBy(0.5, "viewport");
        return;
      }

      // Ctrl+U - half page up
      if (key.ctrl && key.name === "u") {
        scrollbox.scrollBy(-0.5, "viewport");
        return;
      }
    }

    if (key.option) {
      if (key.eventType === "release") {
        scrollAcceleration.multiplier = 1;
      } else {
        scrollAcceleration.multiplier = 10;
      }
    }
  });

  if (parsedFiles.length === 0) {
    return (
      <box
        onMouseUp={onMouseUp}
        onMouseDown={onMouseDown}
        style={{
          padding: 1,
          backgroundColor: getResolvedTheme(themeName).background,
        }}
      >
        <text>No files to display</text>
      </box>
    );
  }

  // Use preview theme if hovering, otherwise use selected theme
  const activeTheme = previewTheme ?? themeName;
  const resolvedTheme = getResolvedTheme(activeTheme);
  const bgColor = resolvedTheme.background;
  const textColor = rgbaToHex(resolvedTheme.text);
  const mutedColor = rgbaToHex(resolvedTheme.textMuted);

  const dropdownOptions = parsedFiles.map((file, idx) => {
    const name = getFileName(file);
    return {
      title: name,
      value: String(idx),
      keywords: name.split("/"),
    };
  });

  // Build tree data for directory tree view
  const treeFiles: TreeFileInfo[] = parsedFiles.map((file, idx) => {
    const { additions, deletions } = countChanges(file.hunks);
    return {
      path: getFileName(file),
      status: getFileStatus(file),
      additions,
      deletions,
      fileIndex: idx,
    };
  });

  // Scroll to file by index
  const scrollToFile = (index: number) => {
    const scrollbox = scrollboxRef.current;
    const fileRef = fileRefs.current.get(index);
    if (scrollbox && fileRef) {
      const contentY = scrollbox.content?.y ?? 0;
      const targetY = fileRef.y - contentY;
      scrollbox.scrollTo(Math.max(0, targetY));
    }
  };

  const handleFileSelect = (value: string) => {
    const index = parseInt(value, 10);
    scrollToFile(index);
    setShowDropdown(false);
  };

  const handleTreeFileSelect = (fileIndex: number) => {
    scrollToFile(fileIndex);
  };

  const themeOptions = themeNames.map((name) => ({
    title: name,
    value: name,
  }));

  const handleThemeSelect = (value: string) => {
    useAppStore.setState({ themeName: value });
    setShowThemePicker(false);
    setPreviewTheme(null);
  };

  const handleThemeFocus = (value: string) => {
    setPreviewTheme(value);
  };

  // Render all files content (used in both theme picker preview and main view)
  const renderAllFiles = () => (
    <box style={{ flexDirection: "column" }}>
      {/* Directory tree at the top */}
      <box style={{ marginBottom: 2 }}>
        <DirectoryTreeView
          files={treeFiles}
          onFileSelect={handleTreeFileSelect}
          themeName={activeTheme}
        />
      </box>

      {parsedFiles.map((file, idx) => {
        const fileName = getFileName(file);
        const oldFileName = getOldFileName(file);
        const filetype = detectFiletype(fileName);
        const { additions, deletions } = countChanges(file.hunks);
        const viewMode = getViewMode(additions, deletions, width);

        return (
          <box
            key={idx}
            ref={(r: BoxRenderable | null) => {
              if (r) fileRefs.current.set(idx, r);
            }}
            style={{ flexDirection: "column", marginBottom: 2 }}
          >
            {/* File header */}
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
                  <text fg={mutedColor}>{oldFileName.trim()}</text>
                  <text fg={mutedColor}> → </text>
                  <text fg={textColor}>{fileName.trim()}</text>
                </>
              ) : (
                <text fg={textColor}>{fileName.trim()}</text>
              )}
              <text fg="#2d8a47"> +{additions}</text>
              <text fg="#c53b53">-{deletions}</text>
            </box>
            <DiffView
              diff={file.rawDiff || ""}
              view={viewMode}
              filetype={filetype}
              themeName={activeTheme}
            />
          </box>
        );
      })}

      {/* Bottom spacer so any file (including the last/only one) can be scrolled
          to the very top of the viewport, even when content is shorter than the
          screen. Sized to roughly one screen minus the footer/padding rows. */}
      <box
        style={{
          height: Math.max(0, (renderer.height ?? FALLBACK_TERMINAL_ROWS) - FOOTER_RESERVED_ROWS),
          flexShrink: 0,
        }}
      />
    </box>
  );

  // Always render the same structure - scrollbox is never remounted
  return (
    <box
      onMouseUp={onMouseUp}
      onMouseDown={onMouseDown}
      style={{
        flexDirection: "column",
        height: "100%",
        padding: 1,
        backgroundColor: bgColor,
      }}
    >
      {/* Dropdown overlay - conditionally shown */}
      {showThemePicker && (
        <box style={{ flexShrink: 0, maxHeight: 15 }}>
          <Dropdown
            tooltip="Select theme"
            options={themeOptions}
            selectedValues={[themeName]}
            onChange={handleThemeSelect}
            onFocus={handleThemeFocus}
            onEscape={() => {
              setShowThemePicker(false);
              setPreviewTheme(null);
            }}
            placeholder="Search themes..."
            itemsPerPage={6}
            theme={resolvedTheme}
          />
        </box>
      )}
      {showDropdown && (
        <box style={{ flexShrink: 0, maxHeight: 15 }}>
          <Dropdown
            tooltip="Select file"
            options={dropdownOptions}
            selectedValues={[]}
            onChange={handleFileSelect}
            onEscape={() => {
              setShowDropdown(false);
            }}
            placeholder="Search files..."
            itemsPerPage={6}
            theme={resolvedTheme}
          />
        </box>
      )}

      {/* Scrollbox - always mounted, preserves scroll position */}
      <scrollbox
        ref={scrollboxRef}
        scrollY
        scrollAcceleration={scrollAcceleration}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          rootOptions: {
            backgroundColor: bgColor,
            border: false,
          },
          contentOptions: {
            minHeight: 0,
          },
          scrollbarOptions: {
            showArrows: false,
            trackOptions: {
              foregroundColor: mutedColor,
              backgroundColor: bgColor,
            },
          },
        }}
        focused={!showDropdown && !showThemePicker}
      >
        {renderAllFiles()}
      </scrollbox>

      {/* Footer - hidden when dropdown is open */}
      {!showDropdown && !showThemePicker && (
        <box
          style={{
            paddingTop: 1,
            paddingLeft: 1,
            paddingRight: 1,
            flexShrink: 0,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <text fg={textColor}>p</text>
          <text fg={mutedColor}> files ({parsedFiles.length})  </text>
          <text fg={textColor}>t</text>
          <text fg={mutedColor}> theme</text>
          <box flexGrow={1} />
          {copyToast ? (
            <text fg={mutedColor}>{copyToast}</text>
          ) : null}
        </box>
      )}
    </box>
  );
}

// Hunks commands for non-interactive selective staging
cli
  .command("hunks list", "List all hunks with stable IDs for selective staging")
  .option("--staged", "List staged hunks instead of unstaged")
  .option("--filter <pattern>", wrapJsonSchema<string[]>({
    type: "array",
    items: { type: "string" },
    description: "Filter files by glob pattern (can be used multiple times)",
  }))
  .action(async (options) => {
    ensureGitRepo();
    const {
      parseHunksWithIds,
      hunkToStableId,
    } = await import("./review/index.js");

    // Build git command - unstaged by default, staged with --staged
    const gitCommand = buildGitCommand({
      staged: options.staged,
      filter: options.filter,
    });

    const { stdout: gitDiff } = await execAsync(gitCommand, {
      encoding: "utf-8",
    });

    // In default (unstaged) mode, append dirty submodule diffs
    let fullHunksDiff = gitDiff;
    if (!options.staged) {
      const dirtySubmodules = getDirtySubmodulePaths();
      if (dirtySubmodules.length > 0) {
        const subCmd = buildSubmoduleDiffCommand(dirtySubmodules, {});
        try {
          const { stdout: subDiff } = await execAsync(subCmd, { encoding: "utf-8" });
          if (subDiff.trim()) {
            fullHunksDiff = fullHunksDiff + "\n" + subDiff;
          }
        } catch {
          // Submodule diff failed — skip
        }
      }

      fullHunksDiff = await filterCombinedDiffByPatterns(fullHunksDiff, {
        filter: options.filter,
        positionalFilters: options['--'],
      });
    }

    if (!fullHunksDiff.trim()) {
      console.log(options.staged ? "No staged changes" : "No unstaged changes");
      process.exit(0);
    }

    const hunks = await parseHunksWithIds(stripSubmoduleHeaders(fullHunksDiff));

    if (hunks.length === 0) {
      console.log("No hunks found");
      process.exit(0);
    }

    // Output each hunk with its stable ID
    for (const hunk of hunks) {
      const stableId = hunkToStableId(hunk);
      console.log(stableId);

      // Print the @@ header line
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      console.log(header);

      // Print first few lines of content (max 5 non-context lines for preview)
      let printed = 0;
      for (const line of hunk.lines) {
        if (printed >= 5) break;
        // Only print change lines for preview, not context
        if (line.startsWith("+") || line.startsWith("-")) {
          console.log(line);
          printed++;
        }
      }

      console.log("---");
    }
  });

cli
  .command("hunks add [...ids]", "Stage specific hunks by their stable ID")
  .action(async (ids: string[]) => {
    ensureGitRepo();
    if (!ids || ids.length === 0) {
      console.error("Usage: critique hunks add <hunk-id> [<hunk-id> ...]");
      console.error("Use 'critique hunks list' to see available hunk IDs.");
      process.exit(1);
    }

    const {
      parseHunksWithIds,
      findHunkByStableId,
      parseHunkId,
      combineHunkPatches,
    } = await import("./review/index.js");

    // Step 1: Parse all IDs upfront, group by filename
    const fileGroups = new Map<string, string[]>();
    for (const id of ids) {
      const parsed = parseHunkId(id);
      if (!parsed) {
        console.error(`Invalid hunk ID format: ${id}`);
        console.error("Expected format: file:@-oldStart,oldLines+newStart,newLines");
        process.exit(1);
      }
      const existing = fileGroups.get(parsed.filename);
      if (existing) existing.push(id);
      else fileGroups.set(parsed.filename, [id]);
    }

    // Step 2: For each file, fetch diff once and resolve all hunks
    const resolvedHunks: Awaited<ReturnType<typeof parseHunksWithIds>> = [];

    for (const [filename, fileIds] of fileGroups) {
      const gitCommand = buildGitCommand({
        staged: false,
        filter: filename,
      });

      const { stdout: gitDiff } = await execAsync(gitCommand, {
        encoding: "utf-8",
      });

      // Keep hunk lookup behavior aligned with `hunks list` by appending
      // dirty submodule diffs before parsing and searching for stable IDs.
      let fullHunksDiff = gitDiff;
      const dirtySubmodules = getDirtySubmodulePaths();
      if (dirtySubmodules.length > 0) {
        const subCmd = buildSubmoduleDiffCommand(dirtySubmodules, {});
        try {
          const { stdout: subDiff } = await execAsync(subCmd, {
            encoding: "utf-8",
          });
          if (subDiff.trim()) {
            fullHunksDiff = fullHunksDiff + "\n" + subDiff;
          }
        } catch {
          // Submodule diff failed — skip
        }
      }

      fullHunksDiff = await filterCombinedDiffByPatterns(fullHunksDiff, {
        filter: filename,
      });

      if (!fullHunksDiff.trim()) {
        console.error(`No unstaged changes in file: ${filename}`);
        process.exit(1);
      }

      const hunks = await parseHunksWithIds(stripSubmoduleHeaders(fullHunksDiff));

      for (const stableId of fileIds) {
        const hunk = findHunkByStableId(hunks, stableId);
        if (!hunk) {
          console.error(`Hunk not found: ${stableId}`);
          console.error("The diff may have changed. Run 'critique hunks list' to see current hunks.");
          process.exit(1);
        }
        resolvedHunks.push(hunk);
      }
    }

    // Step 3: Combine all hunks into a single patch and apply atomically.
    // This avoids the line-shift bug where staging hunk A changes line numbers
    // for hunk B in the same file, causing B's stable ID to become stale.
    const combinedPatch = combineHunkPatches(resolvedHunks);
    const tmpFile = join(tmpdir(), `critique-hunk-${Date.now()}.patch`);
    fs.writeFileSync(tmpFile, combinedPatch);

    try {
      execSync(`git apply --cached -p0 "${tmpFile}"`, { stdio: "pipe" });
      for (const id of ids) {
        console.log(`Staged: ${id}`);
      }
    } catch (error) {
      const err = error as { stderr?: Buffer };
      const stderr = err.stderr?.toString() || "Unknown error";
      console.error("Failed to stage hunks:");
      console.error(stderr);
      process.exit(1);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

cli
  .command(
    "[base] [head]",
    "Show diff for git references (defaults to unstaged changes)",
  )
  .option("--staged", "Show staged changes")
  .option("--commit <ref>", "Show changes from a specific commit")
  .option("--watch", "Watch for file changes and refresh diff")
  .option("--context <lines>", "Number of context lines (default: 6)")
  .option("--filter <pattern>", wrapJsonSchema<string[]>({
    type: "array",
    items: { type: "string" },
    description: "Filter files by glob pattern (can be used multiple times)",
  }))
  .option("--theme <name>", "Theme to use for rendering")
  .option("--pdf [filename]", "Generate PDF instead of TUI (default: <tmpdir>/critique-diff-*.pdf)")
  .option("--pdf-page-size <size>", "PDF page size: a4-landscape (default), a4-portrait, a3-landscape, letter-landscape, or WxH in points")
  .option("--open", "Open in viewer (with --pdf)")
  .option("--image", "Generate images instead of TUI (saved to temp directory)")
  .option("--cols <cols>", "Columns for image render (default: 120)")
  .option("--stdin", "Read diff from stdin (for use as a pager)")
  .option("--scrollback", "Output to terminal scrollback instead of TUI (auto-enabled when non-TTY)")
  .action(async (base, head, options) => {
    // Ensure we're inside a git repository before doing anything
    if (!options.stdin) {
      ensureGitRepo();
    }

    // Apply theme if specified (zustand subscription auto-persists)
    if (options.theme && themeNames.includes(options.theme)) {
      useAppStore.setState({ themeName: options.theme });
    }

    // Build git command once (used by all modes)
    const gitCommand = buildGitCommand({
      staged: options.staged,
      commit: options.commit,
      base,
      head,
      context: options.context,
      filter: options.filter,
      positionalFilters: options['--'],
    });

    // Detect default mode (no args): submodule diffs are handled separately
    const isDefaultMode = !options.staged && !options.commit && !base && !head && !options.stdin;

    // Get diff content - from stdin or git
    let diffContent: string;

    if (options.stdin) {
      // Handle stdin mode (for lazygit pager integration)
      // Lazygit uses --color=always by default, so strip ANSI escape codes
      // before parsing the diff (parsePatch expects plain text)
      diffContent = "";
      for await (const chunk of process.stdin) {
        diffContent += chunk;
      }
      diffContent = stripAnsi(diffContent);
    } else {
      // Get diff from git (runs once for all modes)
      const { stdout: gitDiff } = await execAsync(gitCommand, {
        encoding: "utf-8",
      });
      diffContent = gitDiff;

      // In default mode, append diffs from dirty submodules only.
      // The main git diff uses --ignore-submodules=all, so we separately
      // fetch diffs for submodules that have uncommitted changes.
      // This avoids showing submodule ref changes where the submodule
      // itself has already committed everything.
      if (isDefaultMode) {
        const dirtySubmodules = getDirtySubmodulePaths();
        if (dirtySubmodules.length > 0) {
          const subCmd = buildSubmoduleDiffCommand(dirtySubmodules, {
            context: options.context,
          });
          try {
            const { stdout: subDiff } = await execAsync(subCmd, {
              encoding: "utf-8",
            });
            if (subDiff.trim()) {
              diffContent = diffContent + "\n" + subDiff;
            }
          } catch {
            // Submodule diff failed (e.g. submodule not initialized) — skip
          }
        }

        diffContent = await filterCombinedDiffByPatterns(diffContent, {
          filter: options.filter,
          positionalFilters: options['--'],
        });
      }
    }

    // Clean submodule headers once
    const cleanedDiff = stripSubmoduleHeaders(diffContent);

    // Check for empty diff (except for --watch mode which may get content later)
    const shouldWatch = options.watch && !base && !head && !options.commit && !options.stdin;
    if (!cleanedDiff.trim() && !shouldWatch) {
      console.log("No changes to display");
      process.exit(0);
    }

    // Dispatch to appropriate handler with diff content
    if (options.pdf !== undefined) {
      const filename = typeof options.pdf === 'string' ? options.pdf : undefined;
      await runPdfMode(cleanedDiff, {
        filename,
        open: options.open,
        theme: options.theme,
        cols: parseInt(options.cols) || undefined,
        pageSize: options.pdfPageSize,
      });
      return;
    }

    if (options.image) {
      await runImageMode(cleanedDiff, {
        theme: options.theme,
        cols: parseInt(options.cols) || 120,
      });
      return;
    }

    if (options.scrollback || options.stdin || !process.stdout.isTTY) {
      // For scrollback, prefer terminal width over --cols default (240 is for web)
      const scrollbackCols = process.stdout.columns || parseInt(options.cols) || 120;
      await runScrollbackMode(cleanedDiff, {
        theme: options.theme,
        cols: scrollbackCols,
      });
      return;
    }

    // TUI mode
    try {
      // Parallelize diff module loading with renderer creation
      const [diffModule, renderer] = await Promise.all([
        import("diff"),
        createCliRenderer({
          onDestroy() {
            process.exit(0);
          },
          exitOnCtrlC: true,
          useMouse: true,
          enableMouseMovement: true,
        }),
      ]);
      const { parsePatch, formatPatch } = diffModule;

      // Parse initial diff (already have it, no need to fetch again)
      const initialParsedFiles = cleanedDiff.trim()
        ? processFiles(parseGitDiffFiles(cleanedDiff, parsePatch), formatPatch)
        : [];

      function AppWithWatch() {
        // Use initial parsed files, only re-fetch if watching
        const [parsedFiles, setParsedFiles] = React.useState<ParsedFile[] | null>(
          shouldWatch ? null : initialParsedFiles
        );
        const themeName = useAppStore((s) => s.themeName);

        const watchRenderer = useRenderer();

        // Copy selection to clipboard on mouse release
        const { onMouseUp } = useCopySelection();

        // Handle exit keys (Q, Escape) for loading and empty states
        useKeyboard((key) => {
          if (parsedFiles && parsedFiles.length > 0) {
            return;
          }

          if (key.name === "escape" || key.name === "q") {
            watchRenderer.destroy();
          }
        });

        React.useEffect(() => {
          // Skip initial fetch if not watching (we already have the data)
          if (!shouldWatch) {
            return;
          }

          const fetchDiff = async () => {
            try {
              const { stdout: gitDiff } = await execAsync(gitCommand, {
                encoding: "utf-8",
              });

              // In default mode (watch is only enabled in default mode),
              // append dirty submodule diffs
              let fullDiff = gitDiff;
              if (isDefaultMode) {
                const dirtySubmodules = getDirtySubmodulePaths();
                if (dirtySubmodules.length > 0) {
                  const subCmd = buildSubmoduleDiffCommand(dirtySubmodules, {
                    context: options.context,
                  });
                  try {
                    const { stdout: subDiff } = await execAsync(subCmd, {
                      encoding: "utf-8",
                    });
                    if (subDiff.trim()) {
                      fullDiff = fullDiff + "\n" + subDiff;
                    }
                  } catch {
                    // Submodule diff failed — skip
                  }
                }
              }

              if (!fullDiff.trim()) {
                setParsedFiles([]);
                return;
              }

              const files = parseGitDiffFiles(stripSubmoduleHeaders(fullDiff), parsePatch);
              const filteredFiles = isDefaultMode
                ? filterParsedFilesByPatterns(files, {
                    filter: options.filter,
                    positionalFilters: options['--'],
                  })
                : files;
              const processedFiles = processFiles(filteredFiles, formatPatch);
              setParsedFiles(processedFiles);
            } catch (error) {
              setParsedFiles([]);
            }
          };

          // Initial fetch for watch mode
          fetchDiff();

          const cwd = process.cwd();

          const debouncedFetch = debounce(() => {
            fetchDiff();
          }, 200);

          let subscription:
            | Awaited<ReturnType<typeof import("@parcel/watcher").subscribe>>
            | undefined;

          // Lazy-load watcher module only when watching
          getWatcher().then((watcher) => {
            watcher
              .subscribe(cwd, (err, events) => {
                if (err) {
                  return;
                }

                if (events.length > 0) {
                  debouncedFetch();
                }
              })
              .then((sub) => {
                subscription = sub;
              });
          });

          return () => {
            if (subscription) {
              subscription.unsubscribe();
            }
          };
        }, []);

        const defaultBg = getResolvedTheme(themeName).background;

        if (parsedFiles === null) {
          return (
            <box onMouseUp={onMouseUp} style={{ padding: 1, backgroundColor: defaultBg }}>
              <text>Loading...</text>
            </box>
          );
        }

        if (parsedFiles.length === 0) {
          return (
            <box onMouseUp={onMouseUp} style={{ padding: 1, backgroundColor: defaultBg }}>
              <text>No changes to display</text>
            </box>
          );
        }

        return <App parsedFiles={parsedFiles} />;
      }

      createRoot(renderer).render(
        // @ts-ignore - ErrorBoundary class is incompatible with @opentuah/react's ElementClass + React 19 types; works correctly at runtime
        <ErrorBoundary>
          <AppWithWatch />
        </ErrorBoundary>
      );
    } catch (error) {
      console.error("Error getting git diff:", error);
      process.exit(1);
    }
  });

cli
  .command("difftool <local> <remote>", "Git difftool integration")
  .action(async (local: string, remote: string) => {
    ensureGitRepo();
    if (!process.stdout.isTTY) {
      execSync(`git diff --no-ext-diff "${local}" "${remote}"`, {
        stdio: "inherit",
      });
      process.exit(0);
    }

    try {
      const localContent = fs.readFileSync(local, "utf-8");
      const remoteContent = fs.readFileSync(remote, "utf-8");
      const { structuredPatch, formatPatch } = await import("diff");

      const patch = structuredPatch(
        local,
        remote,
        localContent,
        remoteContent,
        "",
        "",
      );

      if (patch.hunks.length === 0) {
        console.log("No changes to display");
        process.exit(0);
      }

      // Add rawDiff for the diff component
      const patchWithRawDiff = {
        ...patch,
        rawDiff: formatPatch(patch),
      };

      const renderer = await createCliRenderer();
      createRoot(renderer).render(
        // @ts-ignore - ErrorBoundary class is incompatible with @opentuah/react's ElementClass + React 19 types; works correctly at runtime
        <ErrorBoundary>
          <App parsedFiles={[patchWithRawDiff]} />
        </ErrorBoundary>
      );
    } catch (error) {
      console.error("Error displaying diff:", error);
      process.exit(1);
    }
  });

cli
  .command("pick <branch>", "Pick files from another branch to apply to HEAD")
  .action(async (branch: string) => {
    ensureGitRepo();
    try {
      const { stdout: currentBranch } = await execAsync(
        "git branch --show-current",
      );
      const current = currentBranch.trim();

      if (current === branch) {
        console.error("Cannot pick from the same branch");
        process.exit(1);
      }

      const { stdout: branchExists } = await execAsync(
        `git rev-parse --verify ${branch}`,
        { encoding: "utf-8" },
      ).catch(() => ({ stdout: "" }));

      if (!branchExists.trim()) {
        console.error(`Branch "${branch}" does not exist`);
        process.exit(1);
      }

      const { stdout: diffOutput } = await execAsync(
        `git diff --name-only HEAD...${branch}`,
        { encoding: "utf-8" },
      );

      const files = diffOutput
        .trim()
        .split("\n")
        .filter((f) => f);

      if (files.length === 0) {
        console.log("No differences found between branches");
        process.exit(0);
      }

      interface PickState {
        selectedFiles: Set<string>;
        appliedFiles: Map<string, boolean>; // Track which files have patches applied
        message: string;
        messageType: "info" | "error" | "success" | "";
      }

      const usePickStore = create<PickState>(() => ({
        selectedFiles: new Set(),
        appliedFiles: new Map(),
        message: "",
        messageType: "",
      }));

      interface PickAppProps {
        files: string[];
        branch: string;
      }

      function PickApp({ files, branch }: PickAppProps) {
        const selectedFiles = usePickStore((s) => s.selectedFiles);
        const message = usePickStore((s) => s.message);
        const messageType = usePickStore((s) => s.messageType);
        const themeName = useAppStore((s) => s.themeName);

        const handleChange = async (value: string) => {
          const isSelected = selectedFiles.has(value);

          if (isSelected) {
            const { error } = execSyncWithError(
              `git checkout HEAD -- "${value}"`,
              { stdio: "pipe" },
            );

            if (error) {
              if (error.includes("did not match any file(s) known to git")) {
                if (fs.existsSync(value)) {
                  fs.unlinkSync(value);
                }
              } else {
                usePickStore.setState({
                  message: `Failed to restore ${value}: ${error}`,
                  messageType: "error",
                });
                return;
              }
            }

            usePickStore.setState((state) => ({
              selectedFiles: new Set(
                Array.from(state.selectedFiles).filter((f) => f !== value),
              ),
              appliedFiles: new Map(
                Array.from(state.appliedFiles.entries()).filter(([k]) => k !== value),
              ),
            }));
          } else {
            const { stdout: mergeBase } = await execAsync(
              `git merge-base HEAD ${branch}`,
              { encoding: "utf-8" },
            );
            const base = mergeBase.trim();

            const { stdout: patchData } = await execAsync(
              `git diff ${base} ${branch} -- ${value}`,
              { encoding: "utf-8" },
            );

            const patchFile = join(
              tmpdir(),
              `critique-pick-${Date.now()}.patch`,
            );
            fs.writeFileSync(patchFile, patchData);

            const result1 = execSyncWithError(
              `git apply --3way "${patchFile}"`,
              {
                stdio: "pipe",
              },
            );

            if (result1.error) {
              const result2 = execSyncWithError(`git apply "${patchFile}"`, {
                stdio: "pipe",
              });

              if (result2.error) {
                usePickStore.setState({
                  message: `Failed to apply ${value}: ${result2.error}`,
                  messageType: "error",
                });
                fs.unlinkSync(patchFile);
                return;
              }
            }

            fs.unlinkSync(patchFile);

            const { stdout: conflictCheck } = await execAsync(
              `git diff --name-only --diff-filter=U -- "${value}"`,
              { encoding: "utf-8" },
            );

            const hasConflict = conflictCheck.trim().length > 0;

            usePickStore.setState((state) => ({
              selectedFiles: new Set([...state.selectedFiles, value]),
              appliedFiles: new Map([...state.appliedFiles, [value, true]]),
              message: hasConflict
                ? `Applied ${value} with conflicts`
                : `Applied ${value}`,
              messageType: hasConflict ? "error" : "",
            }));
          }
        };

        const pickTheme = getResolvedTheme(themeName);

        return (
          <box
            style={{
              padding: 1,
              flexDirection: "column",
              backgroundColor: pickTheme.background,
            }}
          >
            <Dropdown
              tooltip={`Pick files from "${branch}"`}
              onChange={handleChange}
              selectedValues={Array.from(selectedFiles)}
              placeholder="Search files..."
              theme={pickTheme}
              options={files.map((file) => ({
                value: file,
                title: "/" + file,
                keywords: file.split("/"),
              }))}
            />
            {message && (
              <box
                style={{
                  paddingLeft: 2,
                  paddingRight: 2,
                  paddingTop: 1,
                  paddingBottom: 1,
                  marginTop: 1,
                  backgroundColor: pickTheme.background,
                }}
              >
                <text
                  fg={
                    messageType === "error"
                      ? "#ff6b6b"
                      : messageType === "success"
                        ? "#51cf66"
                        : "#ffffff"
                  }
                >
                  {message}
                </text>
              </box>
            )}
          </box>
        );
      }

      const renderer = await createCliRenderer();
      createRoot(renderer).render(<PickApp files={files} branch={branch} />);
    } catch (error) {
      console.error(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  });

if (import.meta.main) {
  cli.help();
  cli.version(packageJson.version);
  cli.parse();
}
