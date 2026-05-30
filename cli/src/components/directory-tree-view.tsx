// DirectoryTreeView - Renders a directory tree with file status colors and change counts.
// Shows added files in green, modified in default text, deleted in red, renamed in yellow.
// Change counts (+n,-n) use green/red for the numbers, brackets are muted.
// Supports click-to-scroll via onFileSelect callback.

import * as React from "react"
import { buildDirectoryTree, type TreeFileInfo, type TreeNode } from "../directory-tree.js"
import { getResolvedTheme, rgbaToHex } from "../themes.js"

export interface DirectoryTreeViewProps {
  /** Files to display in the tree */
  files: TreeFileInfo[]
  /** Callback when a file is clicked (receives fileIndex) */
  onFileSelect?: (fileIndex: number) => void
  /** Theme name for colors */
  themeName: string
}

/**
 * Get the color for a file based on its status
 * Uses diff colors from theme: green (added), red (deleted), yellow (renamed), default text (modified)
 */
function getStatusColor(status: "added" | "modified" | "deleted" | "renamed", theme: ReturnType<typeof getResolvedTheme>): string {
  switch (status) {
    case "added":
      return rgbaToHex(theme.diffAdded) // green
    case "deleted":
      return rgbaToHex(theme.diffRemoved) // red
    case "renamed":
      return rgbaToHex(theme.warning) // yellow - renamed/moved file
    case "modified":
      return rgbaToHex(theme.text) // default text color, same as folders
  }
}

interface TreeNodeLineProps {
  node: TreeNode
  theme: ReturnType<typeof getResolvedTheme>
  mutedColor: string
  textColor: string
  onSelect?: () => void
}

// A file-row text span that never starts a selection, so a press on the row
// navigates (see onMouseDown below) instead of selecting the filename. opentui
// begins a selection on the hit-tested renderable before dispatching the click,
// and `selectable` isn't a valid prop on the row <box>, so it must live on each span.
const RowText: React.FC<{ fg: string; children: React.ReactNode }> = ({ fg, children }) => (
  <text selectable={false} fg={fg}>{children}</text>
)

/**
 * Render a single tree node line with proper colors
 */
const TreeNodeLine: React.FC<TreeNodeLineProps> = ({
  node,
  theme,
  mutedColor,
  textColor,
  onSelect,
}) => {
  const [isHovered, setIsHovered] = React.useState(false)

  if (node.isFile) {
    // File node - colorize based on status
    const pathColor = node.status ? getStatusColor(node.status, theme) : textColor
    const addColor = rgbaToHex(theme.diffAdded) // green
    const delColor = rgbaToHex(theme.diffRemoved) // red
    const hasAdditions = (node.additions ?? 0) > 0
    const hasDeletions = (node.deletions ?? 0) > 0

    return (
      <box
        style={{
          flexDirection: "row",
          backgroundColor: isHovered ? rgbaToHex(theme.backgroundPanel) : undefined,
        }}
        onMouseMove={() => setIsHovered(true)}
        onMouseOut={() => setIsHovered(false)}
        // Pressing on a filename navigates to that file in the diff. mousedown
        // (not mouseup) is used because opentui's selection capture swallows the
        // line's mouseup after a press. The row is marked non-selectable so the
        // click navigates without also starting a text selection (opentui begins
        // a selection on the hit-tested renderable before dispatching the click).
        onMouseDown={onSelect}
      >
        <RowText fg={mutedColor}>{node.prefix}{node.connector}</RowText>
        <RowText fg={pathColor}>{node.displayPath}</RowText>
        <RowText fg={mutedColor}> (</RowText>
        {hasAdditions && <RowText fg={addColor}>+{node.additions}</RowText>}
        {hasAdditions && hasDeletions && <RowText fg={mutedColor}>,</RowText>}
        {hasDeletions && <RowText fg={delColor}>-{node.deletions}</RowText>}
        <RowText fg={mutedColor}>)</RowText>
      </box>
    )
  }

  // Directory node - use muted color for everything
  return (
    <box style={{ flexDirection: "row" }}>
      <text fg={mutedColor}>{node.prefix}{node.connector}</text>
      <text fg={textColor}>{node.displayPath}</text>
    </box>
  )
}

/**
 * DirectoryTreeView component
 * Renders a directory tree with file status colors and click-to-scroll support
 */
export function DirectoryTreeView({
  files,
  onFileSelect,
  themeName,
}: DirectoryTreeViewProps): React.ReactElement | null {
  const nodes = React.useMemo(() => buildDirectoryTree(files), [files])
  const resolvedTheme = getResolvedTheme(themeName)
  const mutedColor = rgbaToHex(resolvedTheme.textMuted)
  const textColor = rgbaToHex(resolvedTheme.text)

  if (nodes.length === 0) {
    return null
  }

  return (
    <box
      style={{
        alignSelf: "center",
        flexDirection: "column",
      }}
    >
      {nodes.map((node, idx) => (
        <TreeNodeLine
          key={idx}
          node={node}
          theme={resolvedTheme}
          mutedColor={mutedColor}
          textColor={textColor}
          onSelect={
            node.isFile && node.fileIndex !== undefined && onFileSelect
              ? () => onFileSelect(node.fileIndex!)
              : undefined
          }
        />
      ))}
    </box>
  )
}
