# Patches on the vendored pxpipe-proxy 0.16.0

Apply from `vendor/pxpipe-proxy/` after any upgrade of the vendored package:

    patch -p1 < ../../patches/pxlite-vendor.patch

`orig/` holds the three upstream files exactly as they were before any patch (for diffing).
Tests that cover each change are the last tests of `test.mjs`.

## What the patch changes (2026-11-16)

1. **Byte-budget trim** (`transform.js`, `tracker.js`). Upstream sends the whole history as text when the
   rendered pages exceed the 18 MiB image budget (`history_reason: image_bytes`). 39 of 2062 Claude requests
   did, all Sonnet with the JetBrains Mono profile (about 423 KB per page against about 102 KB for Spleen),
   carrying 18 % of all cache-write tokens. The patch retries with a smaller image budget (up to 5 tries,
   oldest pages kept) before skipping. Events log gains `native_image_bytes`, `history_byte_trims`.
2. **Tool calls shortened in collapsed history** (`history.js`). Since 2026-11-18 each tool call is one line from
   `tool-lines.mjs` (shared with recall; imported as `../../../../tool-lines.mjs`), every assistant text stays
   (lead-ins carry the reasons for a change of course), and of the tool output only failures (first 600 chars)
   and subagent reports (6000 chars) are kept; a file read or edited many times is listed once.
   Before that date only `[Edit] path` lines and answers survived (history kept for reference below).
   Earlier version: tool results and tool calls are not rendered;
   a file edit stays as one `[Edit] path` line; assistant text that rides with a tool call (lead-ins) is
   dropped; assistant messages without a tool call (the answers) stay. On a real 175-message session the
   collapsed history went from 14 images / 12,115 image tokens to 6 images / 563 (collapsed characters
   169,786 to 6,061). Off with `PXLITE_HISTORY_KEEP_TOOLS=1`.
3. **Compaction summary kept whole** (`history.js`, `transform.js`). A first message that holds Claude Code's
   compaction summary is protected from collapse, and its text is no longer cut to a 2600+1400 character
   head and tail (the middle of a 10,447-character summary was lost after history collapse).

## Not in the patch, in pxlite itself

- `recall-claude.mjs`: the recall note now rides in a `<system-reminder>` because pxpipe collapses an
  unprotected first message and turned the recall images into the text `[image]` on long sessions.
- `recall-session.mjs`: type `recall`, `recall <words>` or `recall <id>` in a new Claude Code session to load an
  earlier session of the same project as images. `pxlite sessions [--all] [words]` lists the names and ids.
  The choice is pinned per session id in `~/.pxpipe/recall-pins.json`. `PXLITE_RECALL_SESSION_MAX_IMAGES`
  (default 12) and `PXLITE_RECALL_MAX_CHARS` (default 200000) bound its size.
- `PXLITE_DEBUG_META=1` prints the shape of each request's metadata and header keys to stderr.
