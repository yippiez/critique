// Critique-specific image rendering.
// Uses opentui-image.ts for generic frame-to-image conversion.
// Adds theme resolution and diff-specific rendering.

import type { CapturedFrame } from "@opentuah/core"
import { getResolvedTheme, rgbaToHex } from "./themes.js"
import {
  renderFrameToImage,
  renderFrameToPaginatedImages,
  trimTrailingEmptyLines,
  type RenderImageOptions,
  type RenderPaginatedOptions,
  type PaginatedRenderResult,
  type ImageTheme,
  type FrameLayout,
} from "./opentui-image.js"

// Re-export types from opentui-image for convenience
export type { ImageTheme, FrameLayout }

// ============================================================================
// Critique-specific Options and Types
// ============================================================================

export interface RenderToImagesOptions {
  /** Theme name for colors (default: "tokyonight") */
  themeName?: string
  /** Image width in pixels (default: 1200) */
  imageWidth?: number
  /** Font size in pixels (default: 14) */
  fontSize?: number
  /** Line height multiplier (default: 1.9) */
  lineHeight?: number
  /** Maximum lines per image before splitting (default: 70) */
  maxLinesPerImage?: number
  /** Output format: webp, png, or jpeg (default: webp) */
  format?: "webp" | "png" | "jpeg"
  /** Quality for lossy formats 0-100 (default: 85) */
  quality?: number
}

export interface RenderResult {
  /** Array of image buffers */
  images: Buffer[]
  /** Paths where images were saved */
  paths: string[]
  /** Total number of lines in the output */
  totalLines: number
  /** Number of images generated */
  imageCount: number
}

// ============================================================================
// Theme Resolution Helper
// ============================================================================

/**
 * Convert theme name to ImageTheme for opentui-image.
 */
function resolveTheme(themeName: string): ImageTheme {
  const theme = getResolvedTheme(themeName)
  return {
    background: rgbaToHex(theme.background),
    text: rgbaToHex(theme.text),
  }
}

// ============================================================================
// Paginated Image Rendering
// ============================================================================

/**
 * Render a CapturedFrame to images.
 * This is the main rendering function that takes opentui's captured frame format.
 *
 * @param frame - CapturedFrame from opentui test renderer
 * @param options - Rendering options
 * @returns Promise with image buffers and saved file paths
 */
export async function renderFrameToImages(
  frame: CapturedFrame,
  options: RenderToImagesOptions = {}
): Promise<RenderResult> {
  const {
    themeName = "tokyonight",
    imageWidth = 1200,
    fontSize = 14,
    lineHeight = 1.9,
    maxLinesPerImage = 70,
    format = "webp",
    quality = 85,
  } = options

  const theme = resolveTheme(themeName)

  const result = await renderFrameToPaginatedImages(frame, {
    width: imageWidth,
    fontSize,
    lineHeight,
    paddingX: 32,
    paddingY: 24,
    maxLinesPerImage,
    format,
    quality,
    theme,
    saveToTemp: true,
  })

  return result
}

/**
 * Render a git diff to images.
 * Uses opentui test renderer to capture the diff view, then converts to images.
 *
 * @param diffContent - Raw git diff string
 * @param options - Rendering and image options
 * @returns Promise with image buffers and saved file paths
 */
export async function renderDiffToImages(
  diffContent: string,
  options: {
    cols?: number
    maxRows?: number
    themeName?: string
  } & RenderToImagesOptions = {}
): Promise<RenderResult> {
  const { renderDiffToFrame } = await import("./web-utils.js")

  const cols = options.cols ?? 120
  const maxRows = options.maxRows ?? 10000
  const themeName = options.themeName ?? "tokyonight"

  // Render diff to captured frame using opentui test renderer
  const frame = await renderDiffToFrame(diffContent, {
    cols,
    maxRows,
    themeName,
  })

  // Convert frame to images
  return renderFrameToImages(frame, {
    ...options,
    themeName,
  })
}
