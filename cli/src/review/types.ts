// Type definitions for diff hunk parsing and selective staging.
// Defines IndexedHunk plus coverage-tracking structures used by the hunk parser.

/**
 * A single hunk from the diff with a unique identifier
 */
export interface IndexedHunk {
  id: number
  filename: string
  hunkIndex: number // which hunk in the file (0-based)
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
  rawDiff: string
}

/**
 * A group of related hunks with a description
 * Supports both full hunks and partial hunks (line ranges)
 */
export interface ReviewGroup {
  // Option 1: Multiple full hunks (backwards compatible)
  hunkIds?: number[]
  // Option 2: Single hunk with optional line range
  hunkId?: number
  lineRange?: [number, number] // [startLine, endLine] inclusive, 0-based
  // The markdown description for this group
  markdownDescription: string
}

/**
 * Coverage tracking for hunks
 * Tracks which lines of each hunk have been covered
 */
export interface HunkCoverage {
  hunkId: number
  totalLines: number
  coveredRanges: [number, number][] // list of [start, end] ranges that have been covered
}

/**
 * Overall coverage state
 */
export interface ReviewCoverage {
  hunks: Map<number, HunkCoverage>
  totalHunks: number
  fullyExplainedHunks: number
  partiallyExplainedHunks: number
  unexplainedHunks: number
}

/**
 * Uncovered portion of a hunk
 */
export interface UncoveredPortion {
  hunkId: number
  filename: string
  uncoveredRanges: [number, number][]
  totalUncoveredLines: number
}
