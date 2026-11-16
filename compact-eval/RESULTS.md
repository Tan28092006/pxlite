# Compaction through pxpipe — 2026-11-15

## Question

When Claude Code compacts a long session through pxlite, pxpipe collapses most of the history into images, and the summary is written from those images.
Does that summary still carry the right conclusions?
The user's criterion: small numbers may drift, the conclusions must be read correctly.

## Test

- Copied this session's transcript up to its real compaction (1,470 lines, 345 messages) into a temporary session and ran `/compact` on it through pxlite, Opus 5.5.
- The request: 42 images, `history_reason=collapsed`, 313,622 baseline tokens → 100,668 sent (41,265 input + 59,403 cache write).
- The reference is the summary of the real compaction of the same history, made as text without the proxy.
- Output: `summary-via-images-2026-11-15.md`.

## Result

Right:

- Every user request, verbatim (pxpipe keeps user turns as text).
- The Vietnamese accuracy table, every number exact; vendor path, pid, test count, disk sizes, sample size.
- VS Code settings, ports, CA bundle, keepSharp, zstd, 426, cache-breakpoint strip.

Wrong or missing:

- **Codex setup, wrong final state.**
  It reports `model_provider = "pxlite"` with a `[model_providers.pxlite]` block as current.
  That block was an intermediate step, removed in favour of `openai_base_url` because a custom provider hides the ~160 threads stored as `openai`.
  A next session would have acted on the superseded design.
- **`pxpipe warp` error, wrong cause and fix.**
  It gives "Inappropriate ioctl, fixed by direct HTTPS_PROXY"; the recorded problem was dropped quoted arguments, worked around by piping on stdin.
- **Missing:** the PID-file overwrite bug, the Codex analytics 404, the accidental print of the OpenCode service password (a security note), the history-compression simulation, the RAM figures.
- One AskUserQuestion answer marked "partly illegible" (it lived in an imaged tool_result).
- Log cap given as 100 MB live instead of 50 MB live + 50 MB backup.

Verdict: one run, but it failed the user's criterion on a conclusion that matters (which design is final).

## Change

pxlite now sends compaction requests upstream as plain text (`compat.mjs` `isCompactionRequest`, `requestCtx` in `pxlite.mjs`).
Detection: the last non-system message is a user turn containing "Your task is to create a detailed summary of" (shared by all three Claude Code compaction prompts; Claude Code 2026-11 may append a role `system` message after it).
`PXLITE_COMPACT_IMAGES=1` restores imaging.
`/pxlite/status` counts these as `compactText`.

Verified end to end: a fresh two-turn session compacted through pxlite logged `compressed=false reason=compress=false` for the compaction request and `compactText: 1`.

Cost: the compaction request no longer hits the image-based prompt cache, so it is paid as full text once per compaction (on this session, ~314k tokens instead of ~101k).
