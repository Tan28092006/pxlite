# Recall after compaction (OpenCode, sol/terra) — 2026-11-15

## Goal

After OpenCode compacts a session, the model keeps only a ~5–10k-char summary.
pxlite now also hands back the turns that compaction removed, as images, so the agent forgets less.
User's choices: OpenCode only (not Codex); recall only the latest compaction, never older eras; drop tool output entirely; earlier auto-compaction is acceptable.

## How it works (`recall.mjs`)

- Every sol/terra Responses request from OpenCode is keyed by `prompt_cache_key` (OpenCode's session id) and saved as a snapshot of turn texts under `~/.pxpipe/recall/<sha8>.json` (deleted after 14 days untouched).
- A compaction is recognised by what disappears, so it covers OpenCode's client-side summary and OpenAI server-side `compaction` items alike: at least 4 earlier turns with ≥ 2,000 chars of conversation text are gone, and something new (the summary or compaction item) sits ahead of the turns that survived.
  A revert only drops turns and adds nothing ahead, so it does not count; pruned tool outputs keep their `call_id`, so they do not count.
- The vanished turns become the recall transcript: user asks, assistant text, one line per tool call (≤ 160 chars); tool outputs, `<shell>` results and injected `Instructions from:` file bodies are dropped.
  Budget 200k chars (`PXLITE_RECALL_MAX_CHARS`), most recent kept; at most 24 images (`PXLITE_RECALL_MAX_IMAGES`).
- Every following request in that session gets one user message right after the summary: an intro saying later turns win, the images, an outro.
  The images are rendered once per compaction (cached) and stay byte-identical, so the prompt cache keeps hitting.
- A later compaction replaces the recall with only the turns it removed; the earlier era and its summary are not shown again.
- Subagents: each OpenCode subagent is its own stream, keyed by `prompt_cache_key` plus a hash of its instructions (`instructions` field and system/developer items), so a subagent that shared its parent's key still cannot read the parent's turns as vanished.
  Subagents compact often (opencode.db: terra 21, sol-fast 17, sol 4 completed compactions in child sessions vs 12, 9, 18 in main sessions).
  If instructions change mid-session, that stream's recall starts over (no wrong injection).
- Off switch: `PXLITE_RECALL=0`. Codex requests (`originator` header containing "codex") are skipped.

## Measurements (offline, no API calls)

Real terra session from `opencode.db` (`ses_e302…`, era between its last two compactions: 928 items, 1.28 M chars of JSON), replayed with `recall-e2e.mjs` through recall and pxpipe's ChatGPT proxy with upstream stubbed:

| Transcript rule | Recall chars | Images (764×1944) | Covers whole era |
|---|---|---|---|
| tool output cut to 1,500 chars | 199k (cap hit) | 21 | no |
| tool output dropped, calls ≤ 160 chars, shell/instructions bodies dropped | 98k | 10 | yes |

Render time 0.36 s once per compaction; recall images survive pxpipe's own transform unchanged (`sample-page.png` is page 2).
Era composition: user typed 1k chars, assistant text 18k, tool-call arguments 190k, shell results 107k.

Live check (one short terra request through `opencode-cli run --standalone`): OpenCode sends `prompt_cache_key`, a snapshot was written, the title request on another model was skipped.

## Claude Code (`recall-claude.mjs`)

- Trigger: the first user message contains "This session is being continued from a previous conversation" and "read the full transcript at: <path>.jsonl" (path must be under `~/.claude/projects`).
- Era: transcript entries between the previous and the latest `compact_boundary`; drops tool results, thinking, `isMeta` (skill bodies), sidechains, `<system-reminder>` blocks and earlier summaries.
  Since 2026-11-16 (user choice) all tool calls are dropped except `Edit`/`Write`/`NotebookEdit`, kept as one `[Edit] path` line (each file once), and between two user messages only the last assistant text (the final answer) is kept, not the lead-in sentences. Every turn is an image; no text window (`PXLITE_RECALL_RECENT_TURNS` defaults to 0).
- Images (Claude's Spleen dense profile, 1568 px wide) go into the summary message right after the summary text; at most 12 (`PXLITE_RECALL_CLAUDE_MAX_IMAGES`).
  The intro is 216 chars because pxpipe shows opening-turn text blocks as a ~300-char preview once history collapses.
- Cache key: hash of the summary text, so the transcript is read once per compaction.
- Compaction requests themselves get no recall (and stay text, see `compact-eval/`).

Offline, this session's transcript (`recall-claude-e2e.mjs`): the whole pre-compaction era (345 messages) became 4 images, ~5.9k image tokens, 0.33 s once, 1 ms cached.
After the 2026-11-16 trimming, the same transcript (now 429 messages after the boundary) is 2 images, 1833 image tokens.
Through pxpipe with 269 post-compaction messages: recall images stay in message 0 after the summary, 30 images on the wire (limit 100), intro kept whole.

Live (one tiny session through pxlite, 2026-11-15): told the codeword PELICAN-47, `/compact` with "do not mention any codeword", then asked without tools.
The model answered PELICAN-47, saying it read it from the recalled image after the summary, not from the summary; `compactText: 1`, `claudeRecall.injected: 1`.

## Not yet verified

- A real compaction through pxlite: forcing one costs a full context of quota, so it is left to normal use.
  After the first one, `pxlite status` should show `recall.compactionsSeen ≥ 1` and `recall.injected` growing.
- Whether recall actually improves answers about pre-compaction work (planned: ~15 questions with vs without recall).
- That Codex always sends an `originator` header containing "codex" (known behaviour, not observed here).
