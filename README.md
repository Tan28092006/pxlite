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

pxlite also listens on `127.0.0.1:47822` as an `HTTPS_PROXY`; clients that trust `~/.pxpipe/warp-ca-bundle.pem` get Anthropic Messages, OpenAI Responses, and OpenCode's own Chat Completions calls diverted into pxlite, and every other host is tunnelled untouched.

- **Claude Code in VS Code** (`pxlite setup claude-vscode`): `claudeCode.environmentVariables` in VS Code user settings sets `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`; takes effect for new Claude sessions.
- **OpenCode desktop** (`pxlite setup opencode`): open the Desktop shortcut "OpenCode (pxlite)" after quitting OpenCode; the background service only inherits the variables at start.
  The service (`opencode-cli serve --service`) outlives the app, so the shortcut offers to stop it (Yes/No) before launching.
  `opencode-cli run` talks to that service; add `--standalone` to test with your own environment.
- **Codex app and CLI** (`pxlite setup codex`): `~/.codex/config.toml` sets `openai_base_url = "http://127.0.0.1:47821/backend-api/codex"` (backup: `config.toml.bak-pxlite-20261115`).
  This keeps the built-in `openai` provider, so existing threads stay listed (a custom provider id would not match the ~160 threads stored as `openai`).
  pxlite answers WebSocket upgrades with 426 so Codex falls back to HTTP after one try, and decodes the zstd request bodies Codex sends.
  Delete that line to talk to chatgpt.com directly.
- `pxlite setup autostart` creates `Startup\pxlite.lnk`, which runs `~/.pxpipe/start-hidden.vbs` at logon; a second copy exits because the port is taken.

Models imaged come from `~/.config/pxpipe/config.json`, or from the `config.default.json` that ships with pxlite when that file does not exist (copy it there to change the list): Fable 5, Opus 5.5, Sonnet 5.5, Gemini, gpt-6.1-sol (and sol-fast), gpt-6.1-terra, deepseek.
OpenCode's own provider (`opencode/*`, for example `opencode/deepseek-v4.1-flash-free`) speaks Chat Completions at `opencode.ai/inference/openai/v1`; pxlite diverts that path too and rewrites it to pxpipe's canonical `/v1/chat/completions`.
Every imaged model is drawn in Spleen 5×8 with 2 px added to each row (user's choice 2026-11-18, for the token saving).
Claude models get it from pxpipe's spaced Claude profile; Sol, Terra and DeepSeek get it from `gptProfiles` in the config file (`spleen-5x8`, `cellHBonus` 2, 84 columns, 1954 px pages), which replaces the 14px JetBrains Mono geometry pxlite used for them before.
Gemini keeps pxpipe's measured profile, which is Spleen 5×8 without the extra 2 px; that profile is not overridable from the config.
Spleen reads 84–92 % of Vietnamese syllables on Sonnet 5.5, against 99 % on JetBrains Mono 14 (`vi-eval/RESULTS.md`).
Two measurements argue for caution outside Claude: an image probe at plain Spleen 5×8 made DeepSeek V4.1 Flash Free misread `Y→9` and `O→0`, and pxpipe's own eval collapsed Sol's gist recall to 20/98 on its built-in 5×8 grid.
The 2 px row spacing lifted Claude from 84/98 to 93/98 gist (pxpipe `claude-model-profiles.js`); it has not been measured on Sol, Terra or DeepSeek.
Terra is enabled at the user's request (2026-11-15) although pxpipe has no quality measurement for it.
A 4-file Codex check on terra answered every name and a 34-character `cache_id` correctly; that is one run, not a benchmark, and it ran under the earlier 14px profile.
gpt-6.1-luna still passes through.
Responses cache compatibility is backend-specific: both public OpenAI Responses and
Codex/ChatGPT remove pxpipe's unsupported `prompt_cache_breakpoint` anchor for Sol.
Tool schema properties with the same name are never stripped.
A caller explicitly selecting explicit-only mode is left intact rather than silently
disabling its caching; an unsupported backend can still reject that configuration.
The data-stays-text filter (`keepSharp`) exists only on pxpipe's Anthropic path; GPT history is imaged without it.
`PXLITE_CACHE_TTL` (default `1h`): cache markers that arrive without a `ttl` (OpenCode sends none, so
Anthropic used 5 minutes) get this ttl. Measured on 928 OpenCode requests: the 42 that came after a 5 to 60 minute
pause hit the cache only 3 times and re-wrote 2.66M tokens. Markers with an explicit ttl are never touched, and a
request whose client already chose another ttl is left as it is. `5m` or `off` turns it off. A 1h write costs 2x
instead of 1.25x, so this pays only if you pause often.

`PXLITE_KEEP_SCALE` (default `1.5`) multiplies every data-detection limit of that filter: higher images more, `1` is the original strictness, `0` images everything. `node scripts/keep-report.mjs` measures it on your own transcripts and events log.

## Recall an earlier session (Claude Code + OpenCode, 2026-11-17)

Open a new session in either client and type `recall` as the whole message.
pxlite finds the latest earlier session of the same project, renders its turns as images (user prompts with a marker per pasted image; one line per tool call (file, command, pattern, skill or subagent task, see `tool-lines.mjs`), every assistant text, the first lines of failed calls and subagent reports; successful tool output and thinking dropped) and attaches them to the first message.
The note above the images gives the transcript path and tells the model to answer from the images, and to search the transcript with `rg -uu -F` only for what they do not show or to confirm an exact value, never to read it whole.
The model says which session it loaded and asks what to do next.

- Sessions are interchangeable: a Claude Code session can load an OpenCode session of the same directory and vice versa; candidates of both sources are ranked by update time.
- `recall <words>`: the latest session whose title or opening prompt holds every word.
- `recall <id>`: an OpenCode `ses_…` id or a Claude Code session uuid or its first 6+ characters.
- `pxlite sessions [--all] [words]`: lists names and ids of both sources (`--all` covers every project).
- A miss attaches no images and lists the recent sessions; type `recall <id>` after it (the last command wins).
- The chosen turns are pinned per session and query in `~/.pxpipe/recall-pins-any/` as plaintext (mode 0600, newest 50 kept), so a newer session appearing later cannot change the bytes and break the cache; the source transcript may even be deleted afterwards.
- Runs for every model pxpipe images (config scope) and in every request shape: Anthropic Messages, Responses, and Chat Completions (`opencode/*`). Codex requests are excluded. Size bounds: `PXLITE_RECALL_SESSION_MAX_IMAGES` (12), `PXLITE_RECALL_MAX_CHARS` (200000).
- The recall turn is answered from the images alone: `tools`, `tool_choice` and `parallel_tool_calls` are removed from that one request, so the model cannot open a transcript or DB instead of reading. The next request carries them again. `PXLITE_RECALL_KEEP_TOOLS=1` keeps them.
- `pxlite status` reports `sessionRecall` (Claude Code context) and `openCodeSessionRecall` (OpenCode context); both count every injection, whichever client's session was loaded.
- Collapsed history keeps one line per tool call, every assistant text, failures and subagent reports, and drops tool output; a compaction summary stays whole: see `patches/README.md`.

### Testing recall

`pxlite recall-test [--client opencode|claude|all] [--model <id>]... [--all] [--wait]`

For each model a random password is written into a source session, the run that follows types `recall …`, and the answer must contain the password.
The OpenCode default matrix is `gpt-6.1-sol`, `gpt-6.1-terra` and `opencode/deepseek-v4.1-flash-free`; `--model` takes provider-qualified ids as written in OpenCode.
The password can only come from the compressed images: the requesting session never sees the source.
Test sessions and any pin holding the password are deleted afterwards.
`--wait` blocks until the proxy has been restarted with the current `pxlite.mjs`; without it the command warns when the running proxy is stale.

The OpenCode API is read-only (no direct DB access). `PXLITE_OPENCODE_CLI` overrides the executable path.
The OpenCode message API keeps at most the newest 600 messages; recall retains the latest compaction summary and, after it, user text with attachment markers, assistant text, one line per tool call, failed-call errors and subagent results; tool output, reasoning and system notices are omitted.

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
- **Repeated injected blocks are sent once (Claude Code).**
  A block pasted verbatim into many user messages (`<browser_instruction>…</browser_instruction>`) keeps its first copy per session; later copies become one marker line, text typed next to it stays; `PXLITE_DEDUPE_TAGS` lists the tags (comma-separated, default `browser_instruction`, empty or `0` = off).
- **Old tool results are collapsed without breaking the cache (Claude Code, OpenCode).**
  Successful `Bash` / `PowerShell` / `Edit` / `Write` / patch results older than the newest 30 messages shrink to their first 150 characters plus the last line and a marker; `Write` keeps the first 600 characters of the file in the call. `Read` results shrink only once they are dead weight: the same file was read again (same range, or in full) or edited/written/patched later, judged inside the frozen prefix only so the cache stays valid; a Read nobody superseded stays whole. Shell `rg`/`grep` output is reduced to a `path: line,line,...` index (offsets kept, match text dropped). Errors and failed tests are detected from the first/last 300 characters only (error words in the middle are file contents) and are never touched; `Grep`, `Glob`, web, browse, subagent and MCP results are never touched. The cut line moves only when the cache already expired (gap longer than `PXLITE_CACHE_TTL`, so the prefix is rewritten anyway) or when it lags by a whole chunk of 50 messages and the freed text is worth the rewrite; in between the prefix stays byte-identical. It runs on all three wire shapes: Anthropic Messages (Claude Code), OpenAI Chat Completions (`role: "tool"`) and OpenAI Responses (`function_call_output`) for OpenCode, keyed by `x-opencode-session-id` / `prompt_cache_key`; Chat/Responses count the boundary in `messages` / `input` items. It is not applied to Codex's own requests. `PXLITE_TOOL_COLLAPSE=0` turns it off, `PXLITE_TOOL_COLLAPSE_CHUNK` and `PXLITE_TOOL_COLLAPSE_KEEP` tune it. Simulation: `node scripts/collapse-sim.mjs`.
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

- Claude's imaged history has no per-tool data-classification hook inside it.
  GPT uses separate frozen messages with a local exact-value factsheet per section,
  rather than moving a combined factsheet whenever another section is added.
  Those pages carry an instruction to re-read sources for exact numbers.
- Memory floor is ~100–120 MB at idle (pxpipe's fonts and tokenizer); an 80-turn simulated session peaked near 245 MB RSS with a 16 MB JS heap.
  Windows trims the working set of an idle proxy to a few MB.
- `pxclaude` sets `HTTPS_PROXY` to port 47822 instead of using `pxpipe warp`, which on Windows drops quoted arguments and cannot spawn `claude` from PowerShell (`ENOENT`).
- A skill's body arrives as plain user text, not a tool_result, so it stays text on the turn it is loaded; it is imaged only later, when history collapse covers that turn.
  The skill list and tool docs are imaged on every request as part of the static slab; reference files a skill makes the model `Read` are tool_results and go through the classifier.
- pxlite imports pxpipe's `dist/core` files directly; it warns when the installed version is not 0.16.0.

Tests: `npm test` (`node --test test.mjs test-recall-sessions.mjs test-opencode-session.mjs test-serve.mjs`; needs the built `vendor/`).

- `PXLITE_TOOL_ROUND_CUT=0` turns off cutting between matched call/result pairs in a tool chain; `PXLITE_TOOL_ROUND_KEEP_TAIL` (default 12) is the live tail kept in a chain. An open tool_use is never cut. Test: `test-tool-round-cut.mjs`.

### GPT Responses: sealed summary history

Managed GPT Responses default to `PXLITE_GPT_REASONING_MODE=summary`. At original
client-input checkpoints (`PXLITE_GPT_CHECKPOINT_CHUNK=130`), safely closed old
reasoning is replaced by its **existing public summary**, packed with useful
user/assistant text and GPT tool transcripts into shared history pages. Ciphertext
is never decoded, OCR'd, rendered, or counted as BPE text. Empty public summaries
do not invent a reconstruction of the reasoning. There is no separate reservoir
of 50 old reasoning blobs in this mode.

`PXLITE_GPT_NATIVE_TAIL=30` is the minimum original-input live tail, not 30 tool
rounds and not a sliding maximum. It can grow between checkpoints, and dependency
protection expands it for pending/parallel/malformed/referenced native state.
Completed old Read/success output bodies follow GPT's existing omission policy;
source breadcrumbs, errors, actual subagent reports and continuation handles
survive. Typed child thinking is not imported as a subagent report.

Each source epoch is rendered independently. Closing a later epoch appends pages;
it never fills, repacks or moves an older page's image bytes/factsheet. Static
slab insertion does not affect checkpoint counts. First-user task anchors,
authoritative instructions, original client pixels, rendered recall and unknown
protocol payloads retain native protection. An imaged current task gets a live
native-text guard at the suffix, not a mutable instruction in old pages.

The economic gate prices the shared closed prefix separately from the rewritten
suffix. Known preserved-prefix credit is capped by provider-observed cache usage;
unexplained usage offsets remain conservative, not a guessed ciphertext token
count. Every transition, including retiring old reasoning, must pass the same
economic gate; there is no forced `reasoning_checkpoint` acceptance. If the
ciphertext savings cannot be measured and visible savings do not cover the cache
reload estimate, keep the previous archive and defer the whole transition.
Context safety is a separate override: summary mode uses
`PXLITE_FORCE_COLLAPSE_TOKENS` (default 180000; `0` disables), considering provider
input usage and the calibrated current estimate. Over budget, a different valid
candidate may commit despite failed payback when it cuts at least 4096 visible
tokens / 2%, or retires at least 30 and half the remaining opaque items without
increasing the visible estimate. Tiny or unchanged checkpoints cannot force a
reload. This is logged as `context_budget`, `budget_forced:true`,
`economic_accept:false`; opaque savings remain explicitly unknown. The guard is
not a guarantee that protected native images/dependencies will fit under 180k.
Measure future input/cache and new reasoning to evaluate the trade-off.

Known assistant phases (`commentary`, `final_answer`) are transcribed with their
phase rather than pinning a completed reasoning/tool group native. Projection
version 3 also handles completed interleaved tool intervals, synchronous/direct
caller metadata, named tool outputs, empty assistant wrappers and nullable
ciphertext with known reasoning content. Program/async dependencies, unknown
fields and malformed calls remain native. Namespaced tools keep their qualified
identity; subagent reports/handles survive and parallel wrappers retain each child
breadcrumb. Versions 1, 2 and 3 remain replayable byte-for-byte when the economic
gate rejects an upgrade. `nativeFunctionPairReasons` reports fixed reason counts.

Projection version 4 retires successful old local Read output strictly longer
than 200 characters, without requiring a later read of the same range. It keeps
the exact path and supplied offset/limit (including offset 0) as a re-read
breadcrumb, not the old file body. These Read-only runs do not wait for the
30k history-token floor or a per-page profitability check. Live-tail, image,
reference and protocol protections still apply; the outer cache controller owns
when the v4 layout is committed. A rejected migration replays the old layout
unchanged. Re-reading retrieves the current file, not necessarily its historical
contents.

Projection version 5 follows Claude's two-stage principle on managed Responses:
successful old tool results are projected into breadcrumbs in the same request
that renders history. The projector no longer independently vetoes each small run
with a 30k/per-page gate; the outer gate evaluates the complete outgoing candidate,
including image and exact-value text costs. Read's >200-character rule is unchanged.
Versions 1–4 remain replayable; an upgrade does not silently rewrite sealed pages.

Safe closed reasoning may be retired while keeping its public summary, but opaque
retirement alone no longer overrides a financial rejection below the context
budget. Empty summaries do not acquire fabricated text or ciphertext images.
The separate 180k context guard remains explicit, not claimed financial savings.
Live tool dependencies, referenced items and unknown shapes remain native.

V5 cache economics use the current session's last observed cache ratio and a
conservative sample of its three latest cache ratios for future reads, rather
than assuming every future read hits. After three consecutive observed zero-hit
responses, a layout change must pay immediately without future cache reuse
(`cache_recovery_unproven` otherwise); context safety remains a separate override.
Unchanged layouts are still replayed. Health evidence survives restart in safe
numeric seeds and is isolated by model, route and session. This does not diagnose
or repair provider cache eligibility; a stable local prefix is necessary evidence,
not a guarantee of a provider hit. Claude's marker placement remains unchanged.

For summary mode, the expected number of future reads uses the lower quartile of
at least three completed original-source checkpoint windows. The first partial
window, skipped/reversed windows and other sessions are not credited. Until this
evidence exists, V5 uses Claude's planning horizon of 10 reads
(`PXLITE_HISTORY_HORIZON` can set the fallback); older versions retain the
rewrite-run estimate. The fallback is an assumption, not observed future usage.
This avoids inheriting a
broken old projector's rewrite frequency as the lifetime of the new fixed-grid
layout. Historical full cache misses still price rewrites pessimistically. The
forecast is logged with `horizon_basis`/`source_epoch_samples` and remains an
estimate, not a promise of a cache hit or a particular bill.

Settings: `PXLITE_GPT_REASONING_MODE=native` restores the earlier cache-gated
historical cap (`PXLITE_GPT_REASONING_KEEP=50`). `PXLITE_GPT_CACHE_GATE=0` restores
the legacy Responses path. Claude and legacy Chat are unchanged. The managed path
has no independently advancing destructive tool checkpoint.

Events contain content-free `gpt_cache_gate`/`gpt_prefix` diagnostics, counts, and a
closed-prefix hash. Session/model/route, source-root and policy versions are
isolated. Raw prompts, pixels, ciphertext and credentials are not logged by these
diagnostics. New back-references, old input edits, settings or hard image/byte
limits can require a reset/fail-safe; protocol validity and original pixels win
over cache preservation. A native fallback is never committed as a sealed epoch.

`reasoning_output_tokens`, when provided, is a subset of `output_tokens` and
measures new generation, **not** replayed opaque input. Missing is unknown.
No image-reading reminder is injected into the live request on Claude or GPT.
The legacy `PXLITE_READ_NOTE` setting is ignored, including custom values.
Tests cover protocol/bytes using local fixtures, not paid model calls; they do not
prove inference-quality equivalence after this deliberately lossy compaction.

### GPT client images at history checkpoints

On managed Responses, original client image pixels stay native, not `[image]`.
On legacy Chat/Responses, old client images no longer form permanent history
barriers. Only turns selected by a history checkpoint lose their
pixels. Their rendered history contains `[image]`, or an image source marker when
the request supplies a path, URL or file id. The adjacent tool-call line keeps a
Read path. Inline base64 is never rendered as transcript text. This does not save
inline images to disk or invent a path; re-reading still needs an existing source.

The recent tail stays native. Short/unprofitable requests and unselected turns are
unchanged. There is no rolling 15-image window and no automatic reattachment of old
pixels. Existing frozen sections remain identical as later turns are appended.

The proxy's own system/tool slab and recall images still contain indispensable
rendered text, so those images stay native. Unknown payloads (for example files or
audio), referenced Responses items and unresolved tool calls retain their protocol
guards. Responses custom tool image outputs use the same tool-chain tail floors
as function outputs. Tests: `test-gpt-image-collapse.mjs`.

The separate tool-output checkpoint's step of 50 counts **all** `messages`/`input`
items, not eligible tool results. While its cache is warm it also requires enough
saved characters (default 40,000); the first cold request or an expired cache may
advance directly to the tail boundary. It does not guarantee a cut every 50 items.

### GPT cache contract

- Tool-result checkpoints also cover canonical `/v1/responses`,
  `/v1/chat/completions` and Codex `/backend-api/codex/responses`, not only
  `opencode.ai/inference/openai`. A stable session id is required. Model and wire
  shape are isolated, and a child session's own id wins over a shared affinity key.
- Managed GPT history advances on fixed input-item epochs:
  `PXLITE_GPT_CHECKPOINT_CHUNK` defaults to `130` (`0` disables this epoch rule).
  A chunk-size upgrade waits 130 new source items from the held cutoff and replays
  old pages with their original options until the new candidate is approved.
  Summary Responses keeps at least 30 source items native and waits for a full
  source grid; it does not force-bootstrap a short context. Legacy/native mode
  keeps the earlier 12-item / 6-pair floors and force rule.
- Chat and Responses keep both PNG bytes and exact-value text in their original
  frozen sections. New sections append; old factsheets do not migrate.
- Compaction requests retain complete tool outputs and skip these checkpoints.
  Turning tool-result collapse off does not turn history epoch protection off.
- No rule treats GPT `cache_write_tokens: 0` as proof that cache is empty.
  A checkpoint/model/settings change or upstream routing can still cause a miss;
  this is not a promise of 100% cache hits.
- A changed summary wire is priced as a full cache miss: equal JSON items are not
  proof that a backend reuses that prefix. History also requires at least 40,000
  **visible native-text characters saved** before advancing an existing epoch,
  in addition to the token/payback gate. Ciphertext/base64 do not count. Neither
  opaque reasoning retirement nor the 180k context-budget guard bypasses this
  floor. Cold bootstrap and unchanged-wire replay do not incur a new warm rewrite.
  Claude's separate tool-result 50-item checkpoint policy is unchanged.
- The image cap and geometry are unchanged. When a cap is reached, unselected
  context remains native rather than silently disappearing. Total context includes
  cached tokens; a large cached context is not the same as a large uncached input.

Regression tests: `test-gpt-cache-contract.mjs` and the local-upstream serve tests
compare complete frozen messages and verify the real route/compatibility pipeline.
