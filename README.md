# pxlite

A slim launcher around pxpipe-proxy 0.16.0 for long Claude Code, OpenCode and Codex sessions.
It sends old conversation history to the model as images instead of text, keeps data-like tool output as text, adds Vietnamese glyphs to the renderer, and can recall an earlier session as images.

## Install

Needs Node 20.19 or newer and git.

```
npm i -g https://github.com/Tan28092006/pxlite/archive/refs/heads/main.tar.gz
```

(Not `npm i -g github:Tan28092006/pxlite`: npm 11 links a global git install to a temporary clone it then deletes.)

That installs `pxlite`, `pxclaude` and `pxpipe`, fetches `pxpipe-proxy@0.16.0` from npm and lays pxlite's seven changed files over it (checked by sha256; it refuses to overwrite anything else).

Then:

```
pxclaude                 # starts the proxy hidden, then Claude Code behind it
pxlite setup             # shows which clients are wired; each step below asks before it changes anything
pxlite setup claude-vscode
pxlite setup codex
pxlite setup opencode    # Windows: desktop shortcut "OpenCode (pxlite)"
pxlite setup autostart   # Windows: start the proxy at logon
```

Every `setup` step keeps a `.bak-pxlite-<date>` copy and has `--undo`.
Run `pxclaude` or `pxlite serve` once before `setup` so the proxy creates its CA file (`~/.pxpipe/warp-ca-bundle.pem`).
The CA is local and only used for the hosts pxlite diverts (Anthropic and OpenAI); every other host is tunnelled untouched.

Update: run the same install command again.
Remove: `pxlite setup <target> --undo` for each target you used, `pxlite stop`, then `npm rm -g pxlite`.

## Use

```
pxclaude                         # starts pxlite hidden if needed, then claude behind it
pxclaude -p "prompt with spaces" --model claude-opus-5-5
pxlite status                    # requests, images, kept-text reasons, rss, log size
pxlite stop
pxlite classify FILE...          # what pxlite would do with a Read of FILE
pxpipe stats                     # savings report; reads the same events.jsonl
```

`pxclaude` passes its arguments to `claude` unchanged and works on Windows, macOS and Linux.

## Other clients

pxlite also listens on `127.0.0.1:47822` as an `HTTPS_PROXY`; clients that trust `~/.pxpipe/warp-ca-bundle.pem` get Anthropic and OpenAI Responses calls diverted into pxlite, and every other host is tunnelled untouched.

- **Claude Code in VS Code** (`pxlite setup claude-vscode`): `claudeCode.environmentVariables` in VS Code user settings sets `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`; takes effect for new Claude sessions.
- **OpenCode desktop** (`pxlite setup opencode`): open the Desktop shortcut "OpenCode (pxlite)" after quitting OpenCode; the background service only inherits the variables at start.
  The service (`opencode-cli serve --service`) outlives the app, so the shortcut offers to stop it (Yes/No) before launching.
  `opencode-cli run` talks to that service; add `--standalone` to test with your own environment.
- **Codex app and CLI** (`pxlite setup codex`): `~/.codex/config.toml` sets `openai_base_url = "http://127.0.0.1:47821/backend-api/codex"` (backup: `config.toml.bak-pxlite-20261115`).
  This keeps the built-in `openai` provider, so existing threads stay listed (a custom provider id would not match the ~160 threads stored as `openai`).
  pxlite answers WebSocket upgrades with 426 so Codex falls back to HTTP after one try, and decodes the zstd request bodies Codex sends.
  Delete that line to talk to chatgpt.com directly.
- `pxlite setup autostart` creates `Startup\pxlite.lnk`, which runs `~/.pxpipe/start-hidden.vbs` at logon; a second copy exits because the port is taken.

Models imaged come from `~/.config/pxpipe/config.json`: Fable 5, Opus 5.5, Sonnet 5.5, Gemini, gpt-6.1-sol (and sol-fast), gpt-6.1-terra.
Sonnet 5.5 uses the same Spleen 5×8 profile as Opus 5.5 (no override since 2026-11-16). It reads 84–92 % of Vietnamese syllables, against 99 % on JetBrains Mono 14 (`vi-eval/RESULTS.md`); the user chose Spleen for the token saving.
Terra is enabled at the user's request (2026-11-15) although pxpipe has no quality measurement for it; `gptProfiles` in that file gives it Sol's 14px JetBrains Mono / 84-column geometry instead of its built-in 5×8 grid, which collapsed Sol's gist recall to 20/98.
A 4-file Codex check on terra answered every name and a 34-character `cache_id` correctly; that is one run, not a benchmark.
gpt-6.1-luna still passes through.
pxlite strips `prompt_cache_breakpoint` from Responses requests because both the ChatGPT backend and api.openai.com reject it for Sol.
The data-stays-text filter (`keepSharp`) exists only on pxpipe's Anthropic path; GPT history is imaged without it.

## Recall an earlier session (Claude Code, 2026-11-16)

Open a new session and type `recall` as the whole message.
pxlite finds the latest earlier session of the same project that has at least 3 real prompts, renders its turns as images (user prompts, `[Edit] path` lines and final answers; tool calls and results dropped) and attaches them to the first message.
The model says which session it loaded and asks what to do next.

- `recall <words>`: the latest session whose title or opening prompt holds every word.
- `recall <id>`: a session id or its first 6+ hex characters.
- `pxlite sessions [--all] [words]`: lists names and ids (`--all` covers every project).
- A miss attaches no images and lists the recent sessions; type `recall <id>` after it (the last command wins).
- The choice is pinned per session id (`~/.pxpipe/recall-pins.json`), so a newer session appearing later cannot change the bytes and break the cache.
- Only for models pxpipe images (config scope). Size bounds: `PXLITE_RECALL_SESSION_MAX_IMAGES` (12), `PXLITE_RECALL_MAX_CHARS` (200000).
- Collapsed history now drops tool calls and results too, and a compaction summary stays whole: see `patches/README.md`.

## Undo

Remove `claudeCode.environmentVariables` from VS Code settings, the `openai_base_url` line from `~/.codex/config.toml`, `Startup\pxlite.lnk` and the Desktop shortcut, then run `pxlite stop`.

## Vietnamese

pxlite runs a vendored pxpipe 0.16.0 (`vendor/pxpipe-proxy`) whose glyph atlases include every Vietnamese letter; stock pxpipe drew most of them as `[U+1EA3]` escapes.
On one Vietnamese sample, Opus 5.5 transcription went from 22–76 % to 97–99.5 % of syllables, Terra from 72–76 % to 96–100 %, while image tokens fell (142 → 79 for Claude).
Details, raw numbers and rebuild steps: `vi-eval/RESULTS.md`.

## What differs from `pxpipe`

- **Data stays text.**
  A tool_result is kept as text when it looks like data: digit ratio ≥ 0.14, numeric tokens ≥ 30 %, many hex hashes, JSON keys on most lines, CSV/table rows, timestamped log lines, or any 30-line window dense with numbers.
  Prose, Markdown skills and source code may be imaged, and pxpipe's own profitability gate still decides.
  Thresholds are in `classify.mjs` (`LIMITS`), calibrated on research-repo code, docs, results JSON and skill files.
- **The log is capped.**
  `~/.pxpipe/events.jsonl` rotates at 50 MB into one `.1` backup (100 MB at most); files untouched for 14 days are deleted.
  Override with `PXLITE_LOG_MAX_BYTES` and `PXLITE_LOG_MAX_DAYS`; request-body samples are never logged.
- **Compaction stays text.**
  A Claude Code compaction request (`/compact` or auto-compact) is sent without images, because the summary is what the next session lives on.
  One test read from history images kept a superseded Codex setup as the final one (`compact-eval/RESULTS.md`).
  It costs one full-text request per compaction; `PXLITE_COMPACT_IMAGES=1` turns imaging back on.
  Verified for `/compact`; auto-compact is precomputed in the background (`compactMetadata.precomputed`) and could not be forced in `-p` mode, so it is unverified.
  Any request that carries the summary phrase but is not treated as compaction is counted by position in `compactMarkerElsewhere` in `pxlite status`; a `last-user`-like position there after a real auto-compact means a missed shape.
- **Recall after compaction (OpenCode sol/terra, Claude Code).**
  After a compaction, pxlite inserts the turns that compaction removed as images right after the summary, with a note that the summary, later turns and current files win.
  Only the latest compaction is recalled; tool outputs, thinking and reminders are dropped, tool calls kept as one line.
  OpenCode (`recall.mjs`): turns are tracked per session in `~/.pxpipe/recall/` (14 days).
  Claude Code (`recall-claude.mjs`): the era is read from the transcript path named in the summary (only under `~/.claude/projects`), once per compaction.
  `PXLITE_RECALL=0` turns both off; `pxlite status` shows `recall` and `claudeRecall` counters.
  Details and measurements: `recall-eval/RESULTS.md`.
- **No dashboard.**
  pxpipe's dashboard replays the whole events log into memory at startup; pxlite has `/pxlite/status` instead.
- **Render cache 16 MiB** instead of 64 MiB (`PXPIPE_RENDER_CACHE_BYTES`); turning it off triples CPU time and does not save memory.

## Limits

- Old history turns are collapsed into images as one block; pxpipe exposes no per-block hook there.
  Those pages carry pxpipe's exact-value factsheet and an instruction to re-read sources for exact numbers.
- Memory floor is ~100–120 MB at idle (pxpipe's fonts and tokenizer); an 80-turn simulated session peaked near 245 MB RSS with a 16 MB JS heap.
  Windows trims the working set of an idle proxy to a few MB.
- `pxclaude` sets `HTTPS_PROXY` to port 47822 instead of using `pxpipe warp`, which on Windows drops quoted arguments and cannot spawn `claude` from PowerShell (`ENOENT`).
- A skill's body arrives as plain user text, not a tool_result, so it stays text on the turn it is loaded; it is imaged only later, when history collapse covers that turn.
  The skill list and tool docs are imaged on every request as part of the static slab; reference files a skill makes the model `Read` are tool_results and go through the classifier.
- pxlite imports pxpipe's `dist/core` files directly; it warns when the installed version is not 0.16.0.

Tests: `node --test test.mjs`.
