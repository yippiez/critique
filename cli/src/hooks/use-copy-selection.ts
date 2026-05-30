// Hook for copy-to-clipboard on mouse selection.
// When the selection settles (on mouse release) the selected text is copied to
// the clipboard and the selection is cleared (deselected), then onCopied fires so
// the UI can show a confirmation. A delayMs can defer this; it defaults to 0
// (immediate). Uses native clipboard commands with OSC52 fallback.

import { useRenderer } from "@opentuah/react"
import { useCallback, useEffect, useRef } from "react"
import childProcess from "child_process"
import fs from "fs"
import path from "path"

// Whether `cmd` exists on PATH. Scans only native dirs, skipping /mnt/* (WSL's
// Windows mounts), because stat-ing those over the 9p filesystem is slow enough
// (~130ms per miss) to stall the UI. Used once at copy time, then cached.
function commandExists(cmd: string): boolean {
  const dirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d && !d.startsWith("/mnt/"))
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, cmd))) return true
    } catch {
      // ignore unreadable PATH entries
    }
  }
  return false
}

type ClipboardCommand = { cmd: string; args: string[] }

// Resolve the native clipboard command once and cache it. Probing PATH for the
// binary (instead of spawning it) avoids the ~130ms-per-missing-binary cost of
// failed spawns — which, when none are installed (e.g. WSL), blocked the event
// loop for ~400ms on every copy before falling back to OSC52. Cached so the
// PATH scan happens at most once per process.
let cachedClipboard: ClipboardCommand | null | undefined
function resolveClipboardCommand(): ClipboardCommand | null {
  if (cachedClipboard !== undefined) return cachedClipboard

  let result: ClipboardCommand | null = null
  if (process.platform === "darwin") {
    result = { cmd: "pbcopy", args: [] }
  } else if (process.platform === "win32") {
    result = { cmd: "clip.exe", args: [] }
  } else if (process.env.WAYLAND_DISPLAY && commandExists("wl-copy")) {
    result = { cmd: "wl-copy", args: [] }
  } else if (commandExists("xclip")) {
    result = { cmd: "xclip", args: ["-selection", "clipboard"] }
  } else if (commandExists("xsel")) {
    result = { cmd: "xsel", args: ["--clipboard", "--input"] }
  }

  cachedClipboard = result
  return result
}

/**
 * Copy text to system clipboard using native commands.
 * Falls back to OSC52 escape sequence for terminal clipboard (works over SSH).
 */
async function copyToClipboard(text: string, copyOsc52: (value: string) => boolean): Promise<void> {
  const command = resolveClipboardCommand()
  if (command) {
    try {
      await spawnClipboard(command.cmd, command.args, text)
      return
    } catch {
      // Native clipboard failed, fall through to OSC52
    }
  }

  // Fallback: renderer OSC52 utility (works in many terminals, including over SSH)
  copyOsc52(text)
}

/**
 * Spawn a clipboard command and pipe text to it
 */
function spawnClipboard(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = childProcess.spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] })

    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })

    proc.stdin?.write(text)
    proc.stdin?.end()
  })
}

/**
 * Options for useCopySelection.
 */
export interface UseCopySelectionOptions {
  /** Delay in ms after the selection settles before copying + deselecting. Default 0 (immediate). */
  delayMs?: number
  /** Called after the selection has been copied to the clipboard. */
  onCopied?: (text: string) => void
}

/**
 * Mouse handlers returned by useCopySelection. Attach both to the root box.
 */
export interface CopySelectionHandlers {
  /** Attach to the root box's onMouseUp prop — schedules the delayed copy. */
  onMouseUp: () => void
  /** Attach to the root box's onMouseDown prop — cancels a pending copy. */
  onMouseDown: () => void
}

/**
 * Hook for copy-on-selection. When the user releases the mouse after selecting
 * text, the selection is copied to the clipboard and cleared, then onCopied
 * fires (e.g. to show a toast). Attach both returned handlers to the root box.
 *
 * @example
 * ```tsx
 * function App() {
 *   const { onMouseUp, onMouseDown } = useCopySelection({ onCopied: showToast })
 *
 *   return (
 *     <box onMouseUp={onMouseUp} onMouseDown={onMouseDown}>
 *       <text>Select this text to copy it</text>
 *     </box>
 *   )
 * }
 * ```
 */
export function useCopySelection(
  options: UseCopySelectionOptions = {},
): CopySelectionHandlers {
  const { delayMs = 0, onCopied } = options
  const renderer = useRenderer()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Hold the latest onCopied so handlers stay stable across renders.
  const onCopiedRef = useRef(onCopied)
  onCopiedRef.current = onCopied

  const cancelPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // A new press starts a fresh interaction — drop any pending copy so we never
  // copy/clear a stale selection while the user is making a new one.
  const onMouseDown = useCallback(() => {
    cancelPending()
  }, [cancelPending])

  const onMouseUp = useCallback(() => {
    // Note: opentui dispatches the "up" event (and so runs this handler) *before*
    // it calls finishSelection(), so renderer.getSelection().isDragging is still
    // true here for a just-completed drag. We must not gate on isDragging — mouse
    // release already means the selection is settled. The empty-text check below
    // is what skips plain clicks. The selected text is captured synchronously so
    // the later clearSelection() doesn't affect what gets copied.
    const selection = renderer.getSelection()
    if (!selection) return

    const text = selection.getSelectedText()
    if (!text || text.length === 0) return

    cancelPending()
    timerRef.current = setTimeout(async () => {
      timerRef.current = null
      try {
        await copyToClipboard(text, (value) => renderer.copyToClipboardOSC52(value))
      } catch {
        // Silent fail - user can manually copy if needed
      }
      renderer.clearSelection()
      onCopiedRef.current?.(text)
    }, delayMs)
  }, [renderer, delayMs, cancelPending])

  // Warm the clipboard-command cache once at mount, off the interaction path, so
  // the first copy doesn't pay the one-time PATH scan. Also clear any pending
  // timer on unmount.
  useEffect(() => {
    resolveClipboardCommand()
    return cancelPending
  }, [cancelPending])

  return { onMouseUp, onMouseDown }
}
