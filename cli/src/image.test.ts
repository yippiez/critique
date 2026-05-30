import { describe, test, expect, beforeAll } from "bun:test"
import fs from "fs"
import path from "path"

// Check if takumi is available (optional dependency)
let takumiAvailable = false
beforeAll(async () => {
  try {
    await import("@takumi-rs/core")
    await import("@takumi-rs/helpers")
    takumiAvailable = true
  } catch {
    console.log("Skipping image tests: takumi not installed")
  }
})

describe("image rendering", () => {
  // Valid unified diff format - each line in hunk must start with +, -, or space
  // Hunk header: @@ -old_start,old_count +new_start,new_count @@
  const sampleDiff = `diff --git a/src/utils.ts b/src/utils.ts
index 1234567..abcdefg 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,7 @@
 export function add(a: number, b: number) {
   return a + b
 }
+
+export function subtract(a: number, b: number) {
+  return a - b
+}
`

  test("renderDiffToImages generates WebP images", async () => {
    if (!takumiAvailable) {
      console.log("Skipping: takumi not installed")
      return
    }

    const { renderDiffToImages } = await import("./image.js")

    const result = await renderDiffToImages(sampleDiff, {
      cols: 80,
      themeName: "tokyonight",
      maxLinesPerImage: 50,
    })

    // Should generate at least one image
    expect(result.imageCount).toBeGreaterThanOrEqual(1)
    expect(result.images.length).toBe(result.imageCount)
    expect(result.paths.length).toBe(result.imageCount)
    expect(result.totalLines).toBeGreaterThan(0)

    // First image should be a valid buffer
    expect(result.images[0]).toBeInstanceOf(Buffer)
    expect(result.images[0]!.length).toBeGreaterThan(0)

    // Files should exist in /tmp
    for (const path of result.paths) {
      expect(fs.existsSync(path)).toBe(true)
      // Clean up test files
      fs.unlinkSync(path)
    }
  })

  test("renderFrameToImages splits long content into multiple images", async () => {
    if (!takumiAvailable) {
      console.log("Skipping: takumi not installed")
      return
    }

    const { renderDiffToFrame } = await import("./web-utils.js")
    const { renderFrameToImages } = await import("./image.js")

    // Create a frame with enough lines to split
    const longDiff = `diff --git a/long.ts b/long.ts
new file mode 100644
--- /dev/null
+++ b/long.ts
@@ -0,0 +1,100 @@
${Array.from({ length: 100 }, (_, i) => `+line ${i + 1}: some content here`).join("\n")}
`

    const frame = await renderDiffToFrame(longDiff, {
      cols: 80,
      maxRows: 200,
      themeName: "tokyonight",
    })

    const result = await renderFrameToImages(frame, {
      maxLinesPerImage: 30,
      themeName: "tokyonight",
    })

    // Should split into multiple images (100+ lines / 30 = at least 3 images)
    expect(result.imageCount).toBeGreaterThan(1)
    expect(result.images.length).toBe(result.imageCount)

    // Clean up
    for (const path of result.paths) {
      if (fs.existsSync(path)) fs.unlinkSync(path)
    }
  })

  test("renderFrameToImages supports different formats", async () => {
    if (!takumiAvailable) {
      console.log("Skipping: takumi not installed")
      return
    }

    const { renderDiffToImages } = await import("./image.js")

    // Test PNG format
    const pngResult = await renderDiffToImages(sampleDiff, {
      cols: 80,
      format: "png",
    })

    expect(pngResult.paths[0]).toContain(".png")
    expect(pngResult.images[0]!.length).toBeGreaterThan(0)

    // Clean up
    for (const path of pngResult.paths) {
      if (fs.existsSync(path)) fs.unlinkSync(path)
    }
  })

  test("throws error when no content to render", async () => {
    if (!takumiAvailable) {
      console.log("Skipping: takumi not installed")
      return
    }

    const { renderFrameToImages } = await import("./image.js")

    // Empty frame
    const emptyFrame = {
      cols: 80,
      rows: 10,
      cursor: [0, 0] as [number, number],
      lines: [],
    }

    await expect(renderFrameToImages(emptyFrame)).rejects.toThrow("No content to render")
  })
})
