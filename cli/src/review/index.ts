// Diff hunk parsing module for selective staging.
// Provides stable hunk IDs and patch combination used by the `hunks` CLI commands.

export {
  parseHunksWithIds,
  hunksToContextXml,
  createHunkMap,
  buildPatch,
  createHunk,
  calculateLineOffsets,
  createSubHunk,
  initializeCoverage,
  markCovered,
  markHunkFullyCovered,
  updateCoverageFromGroup,
  getUncoveredPortions,
  formatUncoveredMessage,
  hunkToStableId,
  parseHunkId,
  findHunkByStableId,
  combineHunkPatches,
} from "./hunk-parser.js"
export type {
  IndexedHunk,
  ReviewGroup,
  HunkCoverage,
  ReviewCoverage,
  UncoveredPortion,
} from "./types.js"
