# Reviewing Diffs on E-Ink Devices

When you have background coding agents working on your codebase — tools like
[kimaki](https://kimaki.xyz) (runs Claude Code / OpenCode sessions from Discord threads),
[clawdbot](https://clawd.bot) (self-hosted AI assistant that connects to Discord, Slack, Telegram, and more),
or any other agent-based workflow — you often want to review their changes without
sitting at a computer.

Critique can generate PDFs from diffs with full syntax highlighting and diff
formatting. Send the PDF to a Kindle or Boox e-reader and review the work
from your couch, bed, or commute.

The typical flow:
1. An agent makes changes to your codebase (via kimaki, clawdbot, Claude Code, etc.)
2. You run `critique main --pdf` to generate the diff as a PDF
3. You send the PDF to your e-reader (email, cloud sync, or drag-and-drop)
4. You unlock the device and read the syntax-highlighted diff

## Generate a PDF

```bash
# Diff as PDF
critique --pdf
critique --pdf my-diff.pdf
critique main --pdf

# Auto-open after generating
critique --pdf --open
```

The PDF is saved to `/tmp/` by default. Pass a filename to control the output path.

## Send to Kindle

All methods below require a one-time setup: find your Kindle email at
https://amazon.com/mycd → Devices → select your Kindle. Then add your
sending email to the approved list under Preferences → Personal Document Settings.

### zele (recommended, Gmail OAuth)

[zele](https://www.npmjs.com/package/zele) is a Gmail CLI that authenticates
via OAuth — no SMTP passwords or app passwords needed. One-time `zele login`,
then send emails from the command line.

```bash
bun install -g zele

# One-time: authenticate with Google
zele login

# Send the PDF to your Kindle
critique main --pdf /tmp/diff.pdf

zele mail send \
  --to yourname@kindle.com \
  --subject "convert" \
  --body "Diff review" \
  --attach /tmp/diff.pdf
```

Put **"convert"** in the subject to reflow text with adjustable fonts. Without it,
the PDF renders as-is (fixed layout, which actually works well for diffs since
it preserves code formatting).


### Send to Kindle web (manual)

If you don't need automation:
1. Go to https://amazon.com/sendtokindle
2. Drag and drop the PDF
3. Select your device

## Send to Boox

### Syncthing (recommended, fully programmatic)

[Syncthing](https://syncthing.net/) auto-syncs a folder between your computer
and Boox over the local network. No IP addresses to remember, no USB, no
internet required — just same Wi-Fi. Self-hosted and end-to-end encrypted.

**One-time setup:**
1. Install Syncthing on your computer (`brew install syncthing` on macOS)
2. Install Syncthing on the Boox from the Boox Play Store (search "Syncthing")
3. Exchange device IDs between the two
4. Create a shared folder (e.g. `~/Syncthing/boox-diffs` ↔ `/sdcard/Syncthing/boox-diffs`)
5. Disable battery optimization for Syncthing on the Boox so it syncs in the background

**Then forever after:**

```bash
critique main --pdf ~/Syncthing/boox-diffs/diff.pdf
# done — appears on the Boox automatically
```

### Google Drive / Dropbox sync (alternative, needs internet)

Set up cloud sync on your Boox (Settings → Accounts → Google Drive or Dropbox),
then save the PDF directly to the synced folder:

```bash
critique main --pdf ~/Google\ Drive/critique-diffs/diff.pdf
```

Same idea as Syncthing but goes through the cloud instead of local network.

### adb push (alternative, needs IP or USB)

Boox runs Android, so `adb push` works for fully scripted transfers.
Requires either a USB cable or knowing the device IP.

```bash
# USB
adb push /tmp/diff.pdf /sdcard/Download/

# Wi-Fi (Android 11+: pair once via Settings → Developer Options → Wireless debugging)
adb pair 192.168.1.x:45678    # enter pairing code
adb connect 192.168.1.x:34567
adb push /tmp/diff.pdf /sdcard/Download/
```

### Send2Boox (manual, works remotely)

1. Go to https://push.boox.com
2. Log in with your Boox account
3. Upload the PDF — it syncs to your device

## Scripted Workflows

One-liner to generate a diff PDF and email to Kindle:

```bash
critique main --pdf /tmp/diff.pdf && \
  zele mail send \
    --to yourname@kindle.com \
    --subject "convert" \
    --body "Diff review" \
    --attach /tmp/diff.pdf
```

With swaks (works today):

```bash
critique main --pdf /tmp/diff.pdf && \
  swaks --to yourname@kindle.com \
        --from you@gmail.com \
        --server smtp.gmail.com:587 --tls \
        --auth-user you@gmail.com \
        --auth-password "your-app-password" \
        --header "Subject: convert" \
        --body "Diff review" \
        --attach /tmp/diff.pdf
```

For Boox with Syncthing:

```bash
critique main --pdf ~/Syncthing/boox-diffs/diff-$(date +%Y%m%d).pdf
```

## Quick Reference

| What | Command | Programmatic? |
|------|---------|---------------|
| Diff → PDF | `critique --pdf` | Yes |
| Send to Kindle | `zele mail send --to ...@kindle.com --attach file.pdf` | Yes |
| Send to Boox | Save to Syncthing shared folder | Yes |
| Specific commit | `critique --commit abc123 --pdf` | Yes |
| Branch comparison | `critique main feature --pdf` | Yes |
