/**
 * GPT history-image compression.
 *
 * The static system+tool slab is small (~30k chars); the bulk of a GPT agent
 * request is the conversation transcript, which OpenCode resends in full every
 * turn — the Responses API is driven statelessly here (no `previous_response_id`),
 * so turns 1..N-1 are re-sent as plain text on turn N. pxpipe collapses the OLD
 * closed-tool-call prefix of that transcript into 1-N PNG images and keeps the
 * recent tail as text.
 *
 * OpenAI prompt-caching is automatic and prefix-based: no `cache_control`
 * breakpoints, no 1.25× write premium, cached reads at ~0.1×. The collapse
 * boundary is snapped to a chunk grid so the history image stays byte-identical
 * across turns and keeps hitting that automatic cache (the same flap-avoidance
 * trick src/core/history.ts uses for Anthropic).
 *
 * This mirrors src/core/history.ts but operates on Responses `input` items and
 * Chat `messages` rather than Anthropic Message blocks. The two formats differ
 * enough (function_call/function_call_output vs tool_calls/tool role) that a
 * shared block type isn't worth it; instead each format is lowered to a common
 * HistoryTurn list and the planner/renderer are shared.
 */
import { renderTextToPngs, measureContentCols, reflow, neutralizeSentinel, } from './render.js';
import { DEFAULT_GPT_PROFILE, GPT_MAX_HEIGHT_PX } from './gpt-model-profiles.js';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';
// PXLITE PATCH: same tool-output rules as the Claude path (history.js): in collapsed history a
// tool call is one line (tool-lines.mjs) and of the tool output only failures and subagent
// reports survive. Off with PXLITE_HISTORY_KEEP_TOOLS=1. The raw text still feeds the token
// floor and the profit gate (turn.rawText), so the saving of dropping the output is counted.
import { SUBAGENT_TOOL_NAMES, errorLine, isLaunchAck, reportBlock, toolCallLines, clip, MAX_CALL_CHARS } from '../../../../tool-lines.mjs';
import { looksFailed } from '../../../../collapse-tools.mjs';
const HISTORY_DROP_TOOLS = !/^(1|true|yes|on)$/i.test(process.env.PXLITE_HISTORY_KEEP_TOOLS ?? '');
function parseArgs(raw) {
    if (raw && typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' ? v : {};
    }
    catch {
        return {};
    }
}
/** Tool output kept in collapsed history: '' for a success. */
function keptToolOutput(name, text) {
    const body = typeof text === 'string' ? text : safeJson(text);
    if (looksFailed(body)) return errorLine(name, body);
    if (SUBAGENT_TOOL_NAMES.has(name) && body.trim() && !isLaunchAck(body)) return reportBlock('subagent', body);
    return '';
}
/** Portrait-strip width for GPT history images. Mirrors GPT_STRIP_COLS in
 *  openai.ts (kept local to avoid a circular import): ≤768px wide so OpenAI
 *  doesn't downscale dense text below its OCR-legibility floor. The 384-col
 *  Anthropic dense profile would be scaled to fit OpenAI's 768px box and become
 *  illegible — that profile is Anthropic-only. */
const GPT_HISTORY_COLS = 152;
export const GPT_HISTORY_DEFAULTS = {
    keepTail: 6,
    keepRecentPairs: 6,
    responsesMode: 'pairs',
    minCollapsePrefix: 10,
    minCollapseTokens: 2000,
    cols: GPT_HISTORY_COLS,
    collapseChunk: 10,
    freezeChunk: 10,
    sectionTokens: 2000,
    // GPT path: OpenAI's resize bounds (2048-bbox / 768 short side) permit the tall
    // strip — do NOT re-link to render.ts MAX_HEIGHT_PX (Anthropic's 1568/1.15 MP clamp).
    maxHeightPx: GPT_MAX_HEIGHT_PX,
    style: DEFAULT_GPT_PROFILE.style,
    maxImages: DEFAULT_GPT_PROFILE.history.maxImages,
    reflow: true,
};
// Managed sessions advance on input-item epochs, independent of per-response
// cache counters. Snapshot the live-tail classification at the epoch's start:
// otherwise a newly appended shell result can make an old round eligible again.
export function checkpointWindow(length, opts, start = 0) {
    const chunk = Math.floor(opts.checkpointChunk ?? 0);
    if (!Number.isFinite(chunk) || chunk <= 1)
        return { managed: false, cutoff: length, frameEnd: length };
    // Use one floor in calm and tool phases, so toggling a tail rule cannot
    // uncollapse/re-image an earlier prefix between checkpoints.
    const tail = Math.max(12, opts.keepTail ?? 0, (opts.keepRecentPairs ?? 0) * 2);
    const available = Math.max(0, length - start - tail);
    const explicit = Number.isFinite(opts.checkpointCutoff) && opts.checkpointCutoff >= 0;
    if (!explicit && available < chunk && opts.checkpointBootstrap)
        return { managed: true, cutoff: start + available, frameEnd: length };
    const cutoff = explicit ? Math.max(start, Math.min(start + available, Math.floor(opts.checkpointCutoff)))
        : start + Math.floor(available / chunk) * chunk;
    return { managed: true, cutoff, frameEnd: Math.min(length, cutoff + tail) };
}
function checkpointOptions(opts) {
    return Math.floor(opts.checkpointChunk ?? 0) > 1
        ? { ...opts, keepTail: Math.max(12, opts.keepTail), keepRecentPairs: Math.max(6, opts.keepRecentPairs) }
        : opts;
}
/** Fixed-epoch pruning, not a sliding window. Ciphertext is never interpreted.
 * References and reasoning associated with incomplete/malformed rounds win over
 * the historical cap; live state beyond the fixed frame is left untouched. */
export function responsesReasoningPrune(items, checkpoint, keep = 50) {
    const frameEnd = Math.min(items.length, checkpoint.frameEnd);
    const indices = [];
    for (let i = 0; i < frameEnd; i++)
        if (items[i]?.type === 'reasoning') indices.push(i);
    const limit = Math.max(0, Math.floor(keep));
    if (!Number.isFinite(limit) || indices.length <= limit)
        return { removed: [], kept: indices.length, protected: 0 };
    const referenced = responseReferencedIds(items);
    const closed = new Set(classifyResponsesPairs(items, 0).completed.flatMap(round => round.indices));
    let lastReasoning = -1;
    let openStart = Infinity;
    for (let i = 0; i < items.length; i++) {
        if (items[i]?.type === 'reasoning') lastReasoning = i;
        if ((isResponsesToolCall(items[i]) || isResponsesToolOutput(items[i])) && !closed.has(i))
            openStart = Math.min(openStart, lastReasoning >= 0 ? lastReasoning : i);
    }
    const retainFrom = limit > 0 ? indices.at(-limit) : Infinity;
    let protectedCount = 0;
    const removed = indices.filter(i => {
        const protectedItem = i >= openStart || referenced.has(items[i]?.id);
        if (protectedItem) protectedCount++;
        return i < checkpoint.cutoff && i < retainFrom && !protectedItem;
    });
    return { removed, kept: indices.length - removed.length, protected: protectedCount };
}
function responseHasClientImages(item) {
    return [item?.content, item?.output].some(parts => Array.isArray(parts) && parts.some(isHistoryImagePart));
}
function safeJson(v) {
    if (typeof v === 'string')
        return v;
    try {
        return JSON.stringify(v) ?? '';
    }
    catch {
        return String(v ?? '');
    }
}
// Known client images may lose pixels only inside a selected history checkpoint.
// Do not render inline base64 as text or invent a local path for an attachment.
function isHistoryImagePart(part) {
    return !!part && typeof part === 'object'
        && (part.type === 'input_image' || part.type === 'image_url' || part.type === 'image');
}
function imageHistoryMarker(part) {
    const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
    const source = [part.file_path, part.filePath, part.path, part.source?.path, part.source?.url, url]
        .find((s) => typeof s === 'string' && s.trim() && !/^\s*data:/i.test(s));
    if (source)
        return `[image source: ${JSON.stringify(source)}]`;
    if (typeof part.file_id === 'string' && part.file_id)
        return `[image file_id: ${JSON.stringify(part.file_id)}]`;
    return '[image]';
}
function imageHistoryNotes(content) {
    return Array.isArray(content) ? content.filter(isHistoryImagePart).map(imageHistoryMarker).join('\n') : '';
}
/** null means real unknown protocol payload, not a known image. */
function historyContentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const p of content) {
        if (!p || typeof p !== 'object')
            return null;
        if (isHistoryImagePart(p))
            parts.push(imageHistoryMarker(p));
        else if (p.type === 'refusal' && typeof p.refusal === 'string')
            parts.push(p.refusal);
        else if ((p.type === 'text' || p.type === 'input_text' || p.type === 'output_text') && typeof p.text === 'string')
            parts.push(p.text);
        else
            return null;
    }
    return parts.join('\n\n');
}
/** These images carry rendered text that has no native-text copy here.
 * They are NOT disposable client screenshots. Never replace them with markers. */
export function isRenderedGptContext(item) {
    return Array.isArray(item?.content) && item.content.some((p) => typeof p?.text === 'string' && (
        p.text === '[End of rendered GPT system/tool context.]'
        || p.text.startsWith('[pxlite recall:')
        || p.text.startsWith('[Recall: the conversation turns that the latest context compaction removed,')
        || p.text.startsWith('[Earlier turns in image(s):')
    ));
}
/** Last index i in [from, cutoffExclusive) where every opened tool-call id has a
 *  matching close. Returns from-1 (no collapse) if none. Stops at the first
 *  opaque barrier so unknown items are never swept into the image. */
function findClosedBoundary(turns, cutoffExclusive, from) {
    const open = new Set();
    let lastClosed = from - 1;
    const limit = Math.min(cutoffExclusive, turns.length);
    for (let i = from; i < limit; i++) {
        const t = turns[i];
        if (t.opaque)
            break;
        for (const id of t.openIds)
            open.add(id);
        for (const id of t.closeIds)
            open.delete(id);
        if (open.size === 0)
            lastClosed = i;
    }
    return lastClosed;
}
/** True if [from, toExclusive) opens no tool call it doesn't also close (and hits
 *  no opaque barrier). Used to confirm the pinned user turn sits at a tool-closed
 *  boundary so force-sealing the section before it can't orphan a function call. */
function isClosedPrefix(turns, from, toExclusive) {
    const open = new Set();
    for (let i = from; i < toExclusive; i++) {
        const t = turns[i];
        if (t.opaque)
            return false;
        for (const id of t.openIds)
            open.add(id);
        for (const id of t.closeIds)
            open.delete(id);
    }
    return open.size === 0;
}
/** Join turn texts over [from, toExclusive), skipping empties and `skip` (the
 *  pinned turn, which is emitted as text rather than imaged). */
function joinTurns(turns, from, toExclusive, skip, raw = false) {
    const parts = [];
    for (let i = from; i < toExclusive; i++) {
        if (i === skip)
            continue;
        const s = raw ? (turns[i].rawText ?? turns[i].text) : turns[i].text;
        if (s && s.length > 0)
            parts.push(s);
    }
    return parts.join('\n\n');
}
/**
 * Plan + render a history collapse over pre-lowered turns. Pure w.r.t. the input
 * (caller does the splice and builds the format-specific synthetic item).
 */
export async function planGptCollapse(turns, protectedPrefix, isProfitable, opts = {}) {
    const o = checkpointOptions({ ...GPT_HISTORY_DEFAULTS, ...opts });
    const base = {
        images: [],
        imagesAfter: [],
        imageSources: [],
        imageSourcesAfter: [],
        text: '',
        start: 0,
        endExclusive: 0,
        collapsedTurns: 0,
        collapsedChars: 0,
        droppedChars: 0,
        droppedCodepoints: new Map(),
    };
    const pp = Math.max(0, Math.min(protectedPrefix, turns.length));
    const checkpoint = checkpointWindow(turns.length, o, pp);
    const rawCutoff = checkpoint.managed ? checkpoint.cutoff : turns.length - o.keepTail;
    if (rawCutoff - pp < o.minCollapsePrefix) {
        return { ...base, reason: 'prefix_too_short' };
    }
    // Snap the cutoff down to a collapseChunk grid (relative to pp) so the image
    // stays byte-stable across turns. Floor at pp + minCollapsePrefix.
    const cutoff = o.collapseChunk > 0
        ? Math.min(rawCutoff, Math.max(pp + o.minCollapsePrefix, pp + Math.floor((rawCutoff - pp) / o.collapseChunk) * o.collapseChunk))
        : rawCutoff;
    const boundary = findClosedBoundary(turns, cutoff, pp);
    if (boundary < pp) {
        return { ...base, reason: 'no_closed_prefix' };
    }
    if (boundary + 1 - pp < o.minCollapsePrefix) {
        return { ...base, reason: 'prefix_too_short' };
    }
    const rawEnd = boundary + 1;
    // Pin the LIVE request — the most-recent user turn OVERALL — as legible TEXT so it
    // is never OCR-only. Older user turns stay imaged (they must NOT look like the live
    // request; that's the snap-to-first-prompt guard). The history BEFORE and AFTER the
    // pin both stay imaged, so compression holds.
    //
    // CRITICAL: pin ONLY when the latest user turn falls INSIDE the collapse range. If
    // it sits in the kept tail (ordinary interactive turn) it is already native text —
    // pinning an OLDER in-range user turn would make the pin migrate across collapse-
    // chunk boundaries and re-image frozen history (cache churn). Restricting the pin to
    // the latest user turn means its position is fixed until the next prompt, so the
    // before/after section grid stays byte-stable across a long run. This covers exactly
    // the two shapes that need it: the autonomous single-prompt agent (pin == pp), and a
    // long current turn whose tool loop overflowed the tail (pin in the middle).
    let pinIdx = -1;
    for (let i = turns.length - 1; i >= pp; i--) {
        if (turns[i].userText !== undefined) {
            pinIdx = i;
            break;
        }
    }
    if (pinIdx >= rawEnd)
        pinIdx = -1; // latest user turn is in the live tail → already text
    // Only pin at a tool-closed boundary: a user turn straddled by an open tool call
    // (malformed input) would orphan the call when we seal the section before it.
    if (pinIdx >= 0 && !isClosedPrefix(turns, pp, pinIdx))
        pinIdx = -1;
    // Imaged baseline EXCLUDES the pinned turn (it is emitted as text, not rendered).
    const text = joinTurns(turns, pp, rawEnd, pinIdx);
    const rawText = joinTurns(turns, pp, rawEnd, pinIdx, true);
    // Floor gate in o200k TOKENS, not chars: imaging bills vision tokens and the
    // text baseline is o200k tokens, so the break-even is a token comparison.
    // NOTE: this counts the IMAGEABLE work only (pin excluded), so a small history
    // whose non-pin content is below the floor is left fully as text. That is correct,
    // not a regression: the pinned request stays legible either way, and imaging a
    // sub-floor amount of work would cost more vision tokens than it saves. Only long
    // sessions (where the bug lived) clear the floor and collapse.
    const rawTokens = gptCountTokens(rawText);
    if (!text || rawTokens < o.minCollapseTokens) {
        return { ...base, reason: 'below_min_tokens', collapsedChars: text?.length ?? 0 };
    }
    // Reflow for RENDERING ONLY: pack soft-wrapped lines and mark hard newlines
    // with the ↵ sentinel so the history image is as dense as the static slab
    // (newline-heavy transcripts otherwise burn a full row per short line and
    // show no ↵). `text` itself stays original — it backs the o200k baseline and
    // the chunk-snapped cache byte-stability, so it must not change shape here.
    const safeText = neutralizeSentinel(text);
    let renderText = o.reflow ? reflow(safeText) ?? safeText : text;
    if (!isProfitable(renderText, o.cols, rawText === text ? undefined : rawTokens)) {
        return { ...base, reason: 'not_profitable', collapsedChars: text.length };
    }
    // APPEND-ONLY, TOKEN-LENGTH sectioning. Cut the closed prefix [pp..rawEnd) into
    // sections of ~sectionTokens o200k tokens by walking turns from pp and sealing a
    // section each time its cumulative token count crosses the target. A sealed
    // section's bytes are a pure function of its turn range — independent of where
    // the conversation currently ends — so old sections stay byte-identical (OpenAI
    // prefix-cache hit) as turns are appended; only freshly-sealed sections are new.
    // Leftover tail turns that don't fill a whole section are NOT collapsed: collapse
    // ends at the last SEALED boundary so every emitted image is a frozen section.
    // (freezeChunk 0 = legacy whole-blob: one section spanning the whole range.)
    // The pinned turn force-seals the section before it and starts a fresh section
    // after it, so no image straddles the live request (history stays imaged on both
    // sides). (freezeChunk 0 = legacy whole-blob, still split around the pin.)
    const sections = [];
    if (o.freezeChunk <= 0) {
        if (pinIdx > pp)
            sections.push([pp, pinIdx]);
        const afterStart = pinIdx >= pp ? pinIdx + 1 : pp;
        if (afterStart < rawEnd)
            sections.push([afterStart, rawEnd]);
    }
    else {
        let secStart = pp;
        let acc = 0;
        // Track open tool-call ids so a section is only sealed at a TOOL-CLOSED point.
        // The token threshold can otherwise land between a function_call and its
        // function_call_output: the call gets imaged while the output stays a live
        // item, and OpenAI rejects the orphan with "No tool call found for function
        // call output" (400). The overall [pp, rawEnd) boundary being closed does NOT
        // protect the intermediate section cut — collapseEnd is the live boundary, so
        // it (and every seal) must itself be tool-closed. Anthropic doesn't hit this
        // because it collapses the whole closed prefix with no live leftover.
        const open = new Set();
        for (let i = pp; i < rawEnd; i++) {
            if (i === pinIdx) {
                if (secStart < i)
                    sections.push([secStart, i]);
                secStart = i + 1;
                acc = 0;
                continue;
            }
            acc += gptCountTokens(turns[i].text);
            for (const id of turns[i].openIds)
                open.add(id);
            for (const id of turns[i].closeIds)
                open.delete(id);
            if (acc >= o.sectionTokens && open.size === 0) {
                sections.push([secStart, i + 1]);
                secStart = i + 1;
                acc = 0;
            }
        }
        // Trailing turns [secStart, rawEnd) didn't fill a section → leave as live text.
    }
    if (sections.length === 0) {
        // Closed prefix cleared the floor but no single section sealed (only when
        // sectionTokens > the whole prefix). Treat as below-min rather than emit a
        // cache-unstable partial blob.
        return { ...base, reason: 'below_min_tokens', collapsedChars: text.length };
    }
    const maxImages = Math.max(0, Math.floor(o.maxImages));
    const rendered = [];
    let imgCount = 0;
    let collapseEnd = pp;
    for (const [s, e] of sections) {
        const sectionText = joinTurns(turns, s, e, -1);
        if (!sectionText || sectionText.length === 0)
            continue;
        const safeSection = neutralizeSentinel(sectionText);
        let sectionRender = o.reflow ? reflow(safeSection) ?? safeSection : sectionText;
        // Readable portrait strips (≤768px wide) — legible to OpenAI vision, same as
        // the static slab. renderTextToPngs caps each PNG at MAX_HEIGHT_PX so a tall
        // section pages into N images, all still well under the 10,000-patch budget.
        const sectionImgs = await renderTextToPngs(sectionRender, o.cols, o.style ?? DEFAULT_GPT_PROFILE.style, o.maxHeightPx);
        if (imgCount + sectionImgs.length > maxImages) {
            // TRUE cap: keep the sections already selected, leave this and every later
            // section (and the pin, if not yet reached) as normal text in the remainder.
            break;
        }
        rendered.push({ s, e, imgs: sectionImgs });
        imgCount += sectionImgs.length;
        collapseEnd = e;
    }
    // The pin is "consumed" (emitted as text inside the synthetic) only once we have
    // collapsed PAST it. If the image cap stopped us before the pin, it survives as a
    // native user message in the untouched remainder — still legible, no work lost.
    const pinConsumed = pinIdx >= pp && collapseEnd > pinIdx;
    const imagesBefore = [];
    const imagesAfter = [];
    const imageSources = [];
    const imageSourcesAfter = [];
    for (const r of rendered) {
        // Source preview uses the original serialized section (not reflow/IDS) so it
        // remains byte-exact. Multipage sections repeat the same source for each PNG.
        const source = joinTurns(turns, r.s, r.e, -1);
        if (pinConsumed && r.s >= pinIdx + 1) {
            imagesAfter.push(...r.imgs);
            imageSourcesAfter.push(...r.imgs.map(() => source));
        }
        else {
            imagesBefore.push(...r.imgs);
            imageSources.push(...r.imgs.map(() => source));
        }
    }
    if (imagesBefore.length === 0 && imagesAfter.length === 0) {
        // First section alone exceeded the cap (or cap <= 0). Fall back to text.
        return { ...base, reason: 'too_many_images', collapsedChars: text.length };
    }
    const pinText = pinConsumed ? turns[pinIdx].userText : undefined;
    // The collapsed transcript / o200k baseline reflects ONLY what we imaged — the
    // pin, when consumed, is text and is excluded from the imaged baseline.
    const collapsedText = joinTurns(turns, pp, collapseEnd, pinConsumed ? pinIdx : -1);
    const droppedCodepoints = new Map();
    let droppedChars = 0;
    for (const img of [...imagesBefore, ...imagesAfter]) {
        droppedChars += img.droppedChars;
        for (const [cp, n] of img.droppedCodepoints) {
            droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
        }
    }
    return {
        images: imagesBefore,
        imagesAfter,
        imageSources,
        imageSourcesAfter,
        pinText,
        text: collapsedText,
        start: pp,
        endExclusive: collapseEnd,
        collapsedTurns: collapseEnd - pp - (pinConsumed ? 1 : 0),
        collapsedChars: collapsedText.length,
        droppedChars,
        droppedCodepoints,
    };
}
/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding.
 *  Used for the history collapse floor (token-, not char-based). */
function gptCountTokens(text) {
    if (!text)
        return 0;
    try {
        return o200kCountTokens(text);
    }
    catch {
        return 0;
    }
}
// ---- Responses completed-pair planning -------------------------------------
function responseRoundText(call, output) {
    const name = typeof call.name === 'string' ? call.name : 'tool';
    // Custom tools take raw input, not necessarily JSON. Preserve that input
    // (notably a screenshot path) rather than silently reducing it to {}.
    const rawInput = call.type === 'custom_tool_call' && typeof call.input === 'string' ? call.input : '';
    const parsed = parseArgs(call.type === 'custom_tool_call' ? call.input : call.arguments);
    const lines = rawInput.trim() && Object.keys(parsed).length === 0
        ? (name === 'patch' || name === 'apply_patch'
            ? toolCallLines(name, { input: rawInput })
            : [`[${name}] ${clip(rawInput.replace(/\s+/g, ' ').trim(), MAX_CALL_CHARS)}`])
        : toolCallLines(name, parsed, { seen: undefined });
    const body = historyContentText(output.output) ?? safeJson(output.output);
    const out = keptToolOutput(name, body) || imageHistoryNotes(output.output);
    return [...lines, out].filter(Boolean).join('\n');
}
function responseCallText(item) {
    const name = typeof item.name === 'string' ? item.name : 'tool';
    const qualifiedName = typeof item.namespace === 'string' && item.namespace && !name.startsWith(`${item.namespace}.`)
        ? `${item.namespace}.${name}` : name;
    const payload = item.type === 'custom_tool_call' ? item.input : item.arguments;
    const args = typeof payload === 'string' ? payload : safeJson(payload);
    return `[tool_use ${qualifiedName}]\n${args}`;
}
function responseOutputText(item) {
    const output = historyContentText(item.output) ?? safeJson(item.output);
    return `[tool_result]\n${output}`;
}
function responseItemType(item) {
    const o = item;
    return o && typeof o.type === 'string' ? o.type : '';
}
/** Shared with Responses accounting so custom tools do not disappear into Other. */
export function isResponsesToolCall(item) {
    const type = responseItemType(item);
    return type === 'function_call' || type === 'custom_tool_call';
}
export function isResponsesToolOutput(item) {
    const type = responseItemType(item);
    return type === 'function_call_output' || type === 'custom_tool_call_output';
}
function isRenderableResponsesPair(call, output) {
    // A matching id alone is insufficient: cross-kind, partial and unknown state
    // must remain native, even if an output happens to be present already.
    if (output.type !== `${call.type}_output`)
        return false;
    if (call.status !== undefined && call.status !== 'completed')
        return false;
    if (output.status !== undefined && output.status !== 'completed')
        return false;
    if (call.type !== 'custom_tool_call')
        return !Array.isArray(output.output) || historyContentText(output.output) !== null;
    if (typeof call.name !== 'string' || !call.name || typeof call.input !== 'string')
        return false;
    if (call.namespace !== undefined && typeof call.namespace !== 'string')
        return false;
    // Custom tools take raw text, NOT JSON arguments. Known images may become
    // markers at a checkpoint; files and unknown payloads must stay native.
    return typeof output.output === 'string'
        || (Array.isArray(output.output) && historyContentText(output.output) !== null);
}
function responseCallId(item) {
    const o = item;
    return o && typeof o.call_id === 'string' ? o.call_id : '';
}
/** Text projection for planning. With collapseImages, known client images become
 * source markers. This does not modify the original item or its live pixels. */
function responseMessageText(item, collapseImages = false) {
    const o = item;
    if (!o || (o.role !== 'user' && o.role !== 'assistant'))
        return null;
    const itemType = typeof o.type === 'string' ? o.type : '';
    if (itemType && itemType !== 'message')
        return null;
    if (isRenderedGptContext(item))
        return null;
    let body = '';
    if (typeof o.content === 'string') {
        body = o.content;
    }
    else if (Array.isArray(o.content)) {
        const parts = [];
        for (const part of o.content) {
            const p = part;
            const type = p && typeof p.type === 'string' ? p.type : '';
            if (!p)
                return null;
            if (isHistoryImagePart(p)) {
                if (!collapseImages)
                    return null;
                parts.push(imageHistoryMarker(p));
                continue;
            }
            // A refusal is plain model-authored prose that happens to ride in its own
            // part type. Rejecting it made the whole message non-imageable, and since
            // a non-imageable message is a hard barrier, ONE refusal split the run and
            // cost a page break. Same for any future part that carries a string
            // `text`: the content is losslessly renderable, so gate on the payload
            // being text rather than on an allow-list of part names.
            if (type === 'refusal' && typeof p.refusal === 'string') {
                parts.push(p.refusal);
                continue;
            }
            if (typeof p.text !== 'string')
                return null;
            parts.push(p.text);
        }
        body = parts.join('\n\n');
    }
    else {
        return null;
    }
    if (!body.trim())
        return null;
    return { role: o.role, text: body };
}
/** True for a `message` item that carries no renderable text at all: empty
 *  content array, or parts whose text is present but blank. Such an item is
 *  inert — imaging it would produce nothing and skipping it changes no
 *  ordering — so it must not end a collapse run. Anything with non-text parts
 *  (images, unknown shapes) is NOT contentless and stays a barrier. */
function isContentlessMessage(item) {
    const o = item;
    if (!o || (o.role !== 'user' && o.role !== 'assistant'))
        return false;
    const itemType = typeof o.type === 'string' ? o.type : '';
    if (itemType && itemType !== 'message')
        return false;
    if (typeof o.content === 'string')
        return !o.content.trim();
    if (!Array.isArray(o.content))
        return false;
    for (const part of o.content) {
        const p = part;
        const type = p && typeof p.type === 'string' ? p.type : '';
        if (!p)
            return false;
        if (type === 'refusal' && typeof p.refusal === 'string') {
            if (p.refusal.trim())
                return false;
            continue;
        }
        // A non-text part means real payload we cannot render — not contentless.
        if (typeof p.text !== 'string')
            return false;
        if (p.text.trim())
            return false;
    }
    return true;
}
function responseMessageTranscript(item, index, collapseImages = false) {
    const msg = responseMessageText(item, collapseImages);
    return msg ? `<${msg.role} t="${index}">\n${msg.text}\n</${msg.role}>` : null;
}
function responseReferencedIds(items) {
    const refs = new Set();
    for (const item of items) {
        const o = item;
        if (!o || o.type !== 'item_reference')
            continue;
        for (const key of ['id', 'item_id', 'ref_id']) {
            if (typeof o[key] === 'string' && o[key])
                refs.add(o[key]);
        }
    }
    return refs;
}
/** Classify Responses tool state without interpreting recency from raw item count.
 * Accept both adjacent pairs and protocol-atomic parallel rounds:
 * `call A, call B, output A, output B`. Unknown/intervening native items remain
 * hard barriers, and duplicate/reversed/orphan state is never selected. */
function classifyResponsesPairs(items, keepRecentPairs, interleaved = false) {
    const calls = new Map();
    const outputs = new Map();
    let missingIdItems = 0;
    for (let i = 0; i < items.length; i++) {
        const call = isResponsesToolCall(items[i]);
        if (!call && !isResponsesToolOutput(items[i]))
            continue;
        const id = responseCallId(items[i]);
        if (!id) {
            missingIdItems++;
            continue;
        }
        const map = call ? calls : outputs;
        const at = map.get(id) ?? [];
        at.push(i);
        map.set(id, at);
    }
    const pairByCallIndex = new Map();
    let openCalls = 0;
    let orphanOutputs = 0;
    let malformedItems = missingIdItems;
    const ids = new Set([...calls.keys(), ...outputs.keys()]);
    for (const id of ids) {
        const cs = calls.get(id) ?? [];
        const os = outputs.get(id) ?? [];
        if (cs.length === 1 && os.length === 1 && cs[0] < os[0]) {
            const callIndex = cs[0];
            const outputIndex = os[0];
            const call = items[callIndex];
            const output = items[outputIndex];
            if (!isRenderableResponsesPair(call, output)) {
                malformedItems += 2;
                continue;
            }
            pairByCallIndex.set(callIndex, {
                callIndex,
                outputIndex,
                text: HISTORY_DROP_TOOLS ? responseRoundText(call, output) : `${responseCallText(call)}\n${responseOutputText(output)}`,
                rawText: `${responseCallText(call)}\n${responseOutputText(output)}`,
                // Match measureResponsesComposition exactly so the share is comparable
                // to its functionCalls/functionOutputs buckets.
                callTokens: gptCountTokens(JSON.stringify(call)),
                outputTokens: gptCountTokens(typeof output.output === 'string' ? output.output : safeJson(output.output)),
            });
        }
        else if (cs.length > 0 && os.length === 0)
            openCalls += cs.length;
        else if (os.length > 0 && cs.length === 0)
            orphanOutputs += os.length;
        else
            malformedItems += cs.length + os.length;
    }
    // Discover contiguous calls* + outputs* rounds. A candidate unique pair that
    // does not fit one of these rounds is non-adjacent protocol state and remains
    // native. This is the shape OpenCode uses for parallel tool calls.
    const completed = [];
    const acceptedCallIndices = new Set();
    if (interleaved) {
        // Close dependency intervals, not just calls* outputs*. A call that opens
        // inside an interval extends it through its output; never select a suffix
        // of an open/unknown interval. Non-tool items are kept in the interval and
        // validated by the summary projector, not silently discarded here.
        for (let i = 0; i < items.length;) {
            if (!isResponsesToolCall(items[i])) { i++; continue; }
            const first = pairByCallIndex.get(i);
            const firstOutputs = outputs.get(responseCallId(items[i])) ?? [];
            let end = first?.outputIndex ?? (firstOutputs.length === 1 && firstOutputs[0] > i
                ? firstOutputs[0] : items.length - 1), valid = !!first;
            const pairs = [], other = [];
            for (let j = i; j <= end; j++) {
                if (isResponsesToolCall(items[j])) {
                    const pair = pairByCallIndex.get(j);
                    if (!pair) {
                        valid = false;
                        const at = outputs.get(responseCallId(items[j])) ?? [];
                        end = Math.max(end, at.length === 1 && at[0] > j ? at[0] : items.length - 1);
                        continue;
                    }
                    pairs.push(pair);
                    end = Math.max(end, pair.outputIndex);
                }
                else if (isResponsesToolOutput(items[j])) {
                    const callIndices = calls.get(responseCallId(items[j]));
                    const pair = callIndices?.length === 1 ? pairByCallIndex.get(callIndices[0]) : null;
                    if (!pair || pair.callIndex < i || pair.outputIndex !== j) valid = false;
                }
                else other.push(j);
            }
            if (pairs.length) {
                completed.push({
                    pairs, indices: Array.from({ length: end - i + 1 }, (_, k) => i + k),
                    interleavedIndices: other, safeProtocol: valid, startIndex: i, endIndex: end,
                    text: pairs.map(pair => pair.text).join('\n\n'),
                    rawText: pairs.map(pair => pair.rawText ?? pair.text).join('\n\n'),
                    callTokens: pairs.reduce((n, pair) => n + pair.callTokens, 0),
                    outputTokens: pairs.reduce((n, pair) => n + pair.outputTokens, 0),
                });
                pairs.forEach(pair => acceptedCallIndices.add(pair.callIndex));
            }
            i = end + 1;
        }
    }
    else {
    for (let i = 0; i < items.length;) {
        if (!isResponsesToolCall(items[i]) || !pairByCallIndex.has(i)) {
            i++;
            continue;
        }
        const calls = [];
        let j = i;
        while (isResponsesToolCall(items[j]) && pairByCallIndex.has(j)) {
            calls.push(pairByCallIndex.get(j));
            j++;
        }
        const roundOutputIndices = new Set(calls.map((pair) => pair.outputIndex));
        const outputs = [];
        // Do not absorb an output belonging to orphan/other state into this round.
        while (isResponsesToolOutput(items[j])
            && roundOutputIndices.has(j)) {
            outputs.push(j);
            j++;
        }
        const outputSet = new Set(outputs);
        const valid = calls.length > 0
            && outputs.length === calls.length
            && calls.every((pair) => outputSet.has(pair.outputIndex));
        if (!valid) {
            i++;
            continue;
        }
        const byOutput = [...calls].sort((a, b) => a.outputIndex - b.outputIndex);
        const indices = [
            ...calls.map((pair) => pair.callIndex),
            ...byOutput.map((pair) => pair.outputIndex),
        ];
        completed.push({
            pairs: calls,
            indices,
            startIndex: i,
            endIndex: j - 1,
            text: byOutput.map((pair) => pair.text).join('\n\n'),
            rawText: byOutput.map((pair) => pair.rawText ?? pair.text).join('\n\n'),
            callTokens: calls.reduce((sum, pair) => sum + pair.callTokens, 0),
            outputTokens: calls.reduce((sum, pair) => sum + pair.outputTokens, 0),
        });
        for (const pair of calls)
            acceptedCallIndices.add(pair.callIndex);
        i = j;
    }
    }
    for (const pair of pairByCallIndex.values()) {
        if (!acceptedCallIndices.has(pair.callIndex))
            malformedItems += 2;
    }
    const keep = Math.max(0, Math.floor(keepRecentPairs));
    let recentStart = completed.length;
    let recentPairs = 0;
    while (recentStart > 0 && recentPairs < keep) {
        recentStart--;
        recentPairs += completed[recentStart].pairs.length;
    }
    const old = completed.slice(0, recentStart);
    const completedPairs = completed.reduce((n, round) => n + round.pairs.length, 0);
    const oldPairs = old.reduce((n, round) => n + round.pairs.length, 0);
    const imageableFunctionCallTokens = old.reduce((n, round) => n + round.callTokens, 0);
    const imageableFunctionOutputTokens = old.reduce((n, round) => n + round.outputTokens, 0);
    return {
        old,
        completed,
        state: {
            completedPairs,
            recentCompletedPairs: completedPairs - oldPairs,
            oldCompletedPairs: oldPairs,
            openCalls,
            orphanOutputs,
            malformedItems,
            imageableFunctionCallTokens,
            imageableFunctionOutputTokens,
            collapsedPairs: 0,
            collapsedFunctionCallTokens: 0,
            collapsedFunctionOutputTokens: 0,
        },
    };
}
function emptyResponsesPairPlan(state) {
    return {
        images: [], imagesAfter: [], imageSources: [], imageSourcesAfter: [],
        text: '', start: 0, endExclusive: 0, collapsedTurns: 0,
        collapsedChars: 0, droppedChars: 0, droppedCodepoints: new Map(),
        segments: [], selectedIndices: [], pairState: state,
    };
}
function freezeResponsesRuns(runs, items, opts, tokensFor) {
    if (opts.freezeChunk <= 0)
        return runs;
    const sections = [];
    const target = Math.max(1, opts.sectionTokens);
    for (const run of runs) {
        let pending = [];
        let tokens = 0;
        const seal = () => {
            if (pending.length > 0)
                sections.push(pending);
            pending = [];
            tokens = 0;
        };
        for (const unit of run) {
            pending.push(unit);
            tokens += tokensFor(unit);
            if (tokens >= target)
                seal();
        }
        const last = run[run.length - 1];
        if (!last)
            continue;
        let nextIndex = last.indices[last.indices.length - 1] + 1;
        while (nextIndex < items.length && isContentlessMessage(items[nextIndex]))
            nextIndex++;
        const next = items[nextIndex];
        if (next && !isResponsesToolCall(next) && !isResponsesToolOutput(next)
            && responseMessageText(next, true) === null)
            seal();
    }
    return sections;
}
/** Profile-gated broad Responses planner. Text/image projections and complete old
 * call/output pairs may share one image group only when they are contiguous.
 * Every other item is a hard barrier, preserving native protocol order/state. */
async function planResponsesMixedCollapse(items, old, completed, state, isProfitable, o) {
    const base = emptyResponsesPairPlan(state);
    const checkpoint = checkpointWindow(items.length, o);
    const planningItems = checkpoint.managed ? items.slice(0, checkpoint.frameEnd) : items;
    const anchoredOld = checkpoint.managed
        ? classifyResponsesPairs(planningItems, o.keepRecentPairs).old.filter(round => round.endIndex < checkpoint.cutoff)
        : old;
    const planningCompleted = checkpoint.managed ? completed.filter(round => round.endIndex < checkpoint.frameEnd) : completed;
    const oldStarts = new Set(anchoredOld.map((round) => round.startIndex));
    const oldByCall = new Map((o.freezeChunk > 0 ? planningCompleted : anchoredOld).map((round) => [round.startIndex, round]));
    const messageIndices = [];
    const referencedIds = responseReferencedIds(items);
    let latestUserIndex = -1;
    let anchoredUserIndex = -1;
    for (let i = 0; i < items.length; i++) {
        const msg = responseMessageText(items[i], !o.preserveClientImages);
        if (!msg)
            continue;
        if (i < planningItems.length)
            messageIndices.push(i);
        if (msg.role === 'user')
            latestUserIndex = i;
        if (msg.role === 'user' && i < planningItems.length)
            anchoredUserIndex = i;
    }
    // slice(-0) returns the WHOLE array, so guard keepTail===0 explicitly —
    // otherwise "protect 0 tail messages" protects every message and blocks
    // all collapse. latestUserIndex is added separately below.
    const tail = Math.max(0, Math.floor(o.keepTail));
    const protectedMessages = new Set(tail > 0 ? messageIndices.slice(-tail) : []);
    if (latestUserIndex >= 0)
        protectedMessages.add(latestUserIndex);
    if (anchoredUserIndex >= 0)
        protectedMessages.add(anchoredUserIndex);
    const runs = [];
    let current = [];
    // Every flush ends a run, and every run renders at least one image. Naming
    // the item type that caused it is the only way to tell an unavoidable
    // barrier (protected tail, item_reference) from an incidental one that is
    // silently costing a page break per occurrence.
    const barrierTypes = new Map();
    const noteBarrier = (index) => {
        if (current.length === 0)
            return; // nothing to split — not a real break
        const t = responseItemType(items[index]) || 'untyped';
        barrierTypes.set(t, (barrierTypes.get(t) ?? 0) + 1);
    };
    const flush = () => {
        if (current.length > 0)
            runs.push(current);
        current = [];
    };
    for (let i = 0; i < planningItems.length; i++) {
        const round = oldByCall.get(i);
        const roundReferenced = !!round && round.indices
            .map((index) => items[index])
            .map((item) => item?.id)
            .some((id) => typeof id === 'string' && referencedIds.has(id));
        const imageRound = round && o.preserveClientImages
            && round.indices.some(index => responseHasClientImages(items[index]));
        if (round && !imageRound && (o.freezeChunk > 0 || !roundReferenced)) {
            current.push({
                eligible: oldStarts.has(round.startIndex) && !roundReferenced,
                indices: round.indices,
                text: round.text,
                baselineTokens: round.callTokens + round.outputTokens,
            });
            i = round.endIndex;
            continue;
        }
        const item = items[i];
        const referenced = !!item && typeof item.id === 'string' && referencedIds.has(item.id);
        const eligible = i < checkpoint.cutoff && !protectedMessages.has(i) && !referenced;
        const text = o.freezeChunk <= 0 && !eligible ? null : responseMessageTranscript(items[i], i, !o.preserveClientImages);
        if (text) {
            current.push({
                eligible,
                indices: [i],
                text,
                baselineTokens: gptCountTokens(responseMessageText(items[i], !o.preserveClientImages).text),
            });
            continue;
        }
        // A contentless message (empty content array, whitespace-only text) carries
        // nothing to image and nothing to reorder, but treating it as a barrier
        // still split the run and cost a page break. Leave it native in place and
        // keep the run open: `selectedIndices` never includes it, so the splice in
        // openai.ts re-emits it at its original position and protocol order is
        // unchanged. Only applies when the item is genuinely a message with no
        // renderable payload — anything unrecognized remains a hard barrier.
        if (!protectedMessages.has(i) && !referenced && isContentlessMessage(items[i])) {
            continue;
        }
        noteBarrier(i);
        flush();
    }
    flush();
    const eligible = runs.flat().filter((unit) => unit.eligible);
    const allText = eligible.map((unit) => unit.text).join('\n\n');
    const allBaselineTokens = eligible.reduce((sum, unit) => sum + unit.baselineTokens, 0);
    if (eligible.length === 0)
        return { ...base, reason: 'no_closed_prefix' };
    if (allBaselineTokens < o.minCollapseTokens) {
        return { ...base, reason: 'below_min_tokens', collapsedChars: allText.length };
    }
    const maxImages = Math.max(0, Math.floor(o.maxImages));
    if (maxImages === 0) {
        return { ...base, reason: 'too_many_images', collapsedChars: allText.length };
    }
    const renderUnits = async (units) => {
        const source = units.map((unit) => unit.text).filter(Boolean).join('\n\n');
        const safe = neutralizeSentinel(source);
        const renderedText = o.reflow ? reflow(safe) ?? safe : safe;
        const cols = o.reflow ? o.cols : measureContentCols(renderedText, o.cols, o.style?.markerScale, o.style?.font);
        const images = await renderTextToPngs(renderedText, cols, o.style ?? DEFAULT_GPT_PROFILE.style, o.maxHeightPx);
        return { source, renderedText, images, cols };
    };
    const segments = [];
    let remainingImages = maxImages;
    let hitImageCap = false;
    const frozenRuns = freezeResponsesRuns(runs, planningItems, o, (unit) => unit.baselineTokens)
        .filter((run) => run.every((unit) => unit.eligible));
    for (const run of frozenRuns) {
        if (remainingImages === 0) {
            hitImageCap = true;
            break;
        }
        let low = 0;
        let high = run.length + 1;
        let best;
        while (low + 1 < high) {
            const count = Math.floor((low + high) / 2);
            const rendered = await renderUnits(run.slice(0, count));
            if (rendered.images.length > 0 && rendered.images.length <= remainingImages) {
                low = count;
                best = rendered;
            }
            else {
                high = count;
            }
        }
        if (!best || low === 0) {
            hitImageCap = true;
            break;
        }
        const selected = run.slice(0, low);
        const selectedBaselineTokens = selected.reduce((sum, unit) => sum + unit.baselineTokens, 0);
        if (!isProfitable(best.renderedText, best.cols, selectedBaselineTokens, best.source))
            continue;
        const selectedIndices = selected.flatMap((unit) => unit.indices).sort((a, b) => a - b);
        segments.push({
            insertAt: selectedIndices[0],
            selectedIndices,
            images: best.images,
            imageSources: best.images.map(() => best.source),
            text: best.source,
            baselineTokens: selectedBaselineTokens,
        });
        remainingImages -= best.images.length;
        if (low < run.length) {
            hitImageCap = true;
            break;
        }
    }
    if (segments.length === 0) {
        return {
            ...base,
            reason: hitImageCap ? 'too_many_images' : 'not_profitable',
            collapsedChars: allText.length,
            barrierTypes,
        };
    }
    const selectedIndices = segments.flatMap((segment) => segment.selectedIndices).sort((a, b) => a - b);
    const selectedIds = new Set(selectedIndices);
    const selectedRounds = old.filter((round) => round.indices.every((index) => selectedIds.has(index)));
    state.collapsedPairs = selectedRounds.reduce((n, round) => n + round.pairs.length, 0);
    state.collapsedFunctionCallTokens = selectedRounds.reduce((n, round) => n + round.callTokens, 0);
    state.collapsedFunctionOutputTokens = selectedRounds.reduce((n, round) => n + round.outputTokens, 0);
    const images = segments.flatMap((segment) => segment.images);
    const imageSources = segments.flatMap((segment) => segment.imageSources);
    const text = segments.map((segment) => segment.text).join('\n\n');
    const baselineTokens = segments.reduce((sum, segment) => sum + (segment.baselineTokens ?? 0), 0);
    const droppedCodepoints = new Map();
    let droppedChars = 0;
    for (const image of images) {
        droppedChars += image.droppedChars;
        for (const [codepoint, count] of image.droppedCodepoints) {
            droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
        }
    }
    return {
        ...base,
        barrierTypes,
        segments,
        images,
        imageSources,
        text,
        baselineTokens,
        start: selectedIndices[0] ?? 0,
        endExclusive: (selectedIndices.at(-1) ?? -1) + 1,
        collapsedTurns: selectedIndices.length,
        collapsedChars: text.length,
        droppedChars,
        droppedCodepoints,
        selectedIndices,
        pairState: state,
    };
}
/** Render only old, unambiguously completed Responses call/output rounds.
 * Native messages, reasoning, recent rounds, open calls, and malformed state stay
 * in place. Consecutive rounds may share pages, but no segment crosses native state. */
export async function planResponsesPairCollapse(items, isProfitable, opts = {}) {
    const o = checkpointOptions({ ...GPT_HISTORY_DEFAULTS, ...opts, freezeChunk: opts.freezeChunk ?? 0 });
    let { old, completed, state } = classifyResponsesPairs(items, o.keepRecentPairs);
    if (o.responsesMode === 'mixed') {
        return planResponsesMixedCollapse(items, old, completed, state, isProfitable, o);
    }
    const checkpoint = checkpointWindow(items.length, o);
    const planningItems = checkpoint.managed ? items.slice(0, checkpoint.frameEnd) : items;
    if (checkpoint.managed) {
        const anchored = new Set(classifyResponsesPairs(planningItems, o.keepRecentPairs).old
            .filter(round => round.endIndex < checkpoint.cutoff).map(round => round.startIndex));
        old = old.filter(round => anchored.has(round.startIndex));
        completed = completed.filter(round => round.endIndex < checkpoint.frameEnd);
    }
    const base = emptyResponsesPairPlan(state);
    if (old.length === 0)
        return { ...base, reason: 'no_closed_prefix' };
    const allText = old.map((pair) => pair.text).filter(Boolean).join('\n\n');
    const allRawTokens = gptCountTokens(old.map((pair) => pair.rawText ?? pair.text).join('\n\n'));
    if (!allText || allRawTokens < o.minCollapseTokens) {
        return { ...base, reason: 'below_min_tokens', collapsedChars: allText.length };
    }
    const maxImages = Math.max(0, Math.floor(o.maxImages));
    if (maxImages === 0) {
        return { ...base, reason: 'too_many_images', collapsedChars: allText.length };
    }
    const runs = [];
    const referencedIds = responseReferencedIds(items);
    const oldStarts = new Set(old.filter((round) => !round.indices.some((index) => {
        if (o.preserveClientImages && responseHasClientImages(items[index])) return true;
        const id = items[index]?.id;
        return typeof id === 'string' && referencedIds.has(id);
    })).map((round) => round.startIndex));
    for (const round of o.freezeChunk > 0 ? completed : old) {
        // In unfrozen mode a referenced round is a native barrier, not a reason
        // to discard every otherwise-safe neighbor in the same contiguous run.
        if (o.freezeChunk <= 0 && !oldStarts.has(round.startIndex))
            continue;
        const run = runs.at(-1);
        if (run && round.startIndex === run.at(-1).endIndex + 1)
            run.push(round);
        else
            runs.push([round]);
    }
    const renderPairs = async (rounds) => {
        const source = rounds.map((round) => round.text).filter(Boolean).join('\n\n');
        const safe = neutralizeSentinel(source);
        let renderedText = o.reflow ? reflow(safe) ?? safe : safe;
        const cols = o.reflow ? o.cols : measureContentCols(renderedText, o.cols, o.style?.markerScale, o.style?.font);
        const images = await renderTextToPngs(renderedText, cols, o.style ?? DEFAULT_GPT_PROFILE.style, o.maxHeightPx);
        return { source, renderedText, images, cols };
    };
    const segments = [];
    let remainingImages = maxImages;
    let hitImageCap = false;
    const frozenRuns = freezeResponsesRuns(runs, planningItems, o, (round) => round.callTokens + round.outputTokens)
        .filter((run) => run.every((round) => oldStarts.has(round.startIndex)));
    for (const run of frozenRuns) {
        if (remainingImages === 0) {
            hitImageCap = true;
            break;
        }
        let low = 0;
        let high = run.length + 1;
        let best;
        while (low + 1 < high) {
            const count = Math.floor((low + high) / 2);
            const rendered = await renderPairs(run.slice(0, count));
            if (rendered.images.length > 0 && rendered.images.length <= remainingImages) {
                low = count;
                best = rendered;
            }
            else {
                high = count;
            }
        }
        if (!best || low === 0) {
            hitImageCap = true;
            break;
        }
        const selected = run.slice(0, low);
        const dropped = selected.some((round) => round.rawText !== undefined && round.rawText !== round.text);
        const selectedRawTokens = dropped ? gptCountTokens(selected.map((round) => round.rawText ?? round.text).join('\n\n')) : undefined;
        if (!isProfitable(best.renderedText, best.cols, selectedRawTokens, best.source))
            continue;
        const selectedIndices = selected
            .flatMap((round) => round.indices)
            .sort((a, b) => a - b);
        segments.push({
            insertAt: selected[0].startIndex,
            selectedIndices,
            images: best.images,
            imageSources: best.images.map(() => best.source),
            text: best.source,
        });
        remainingImages -= best.images.length;
        if (low < run.length) {
            hitImageCap = true;
            break;
        }
    }
    if (segments.length === 0) {
        return {
            ...base,
            reason: hitImageCap ? 'too_many_images' : 'not_profitable',
            collapsedChars: allText.length,
        };
    }
    const selectedIndices = segments
        .flatMap((segment) => segment.selectedIndices)
        .sort((a, b) => a - b);
    const images = segments.flatMap((segment) => segment.images);
    const imageSources = segments.flatMap((segment) => segment.imageSources);
    const text = segments.map((segment) => segment.text).join('\n\n');
    const selectedIds = new Set(selectedIndices);
    const selectedRounds = old.filter((round) => round.indices.every((index) => selectedIds.has(index)));
    state.collapsedPairs = selectedRounds.reduce((n, round) => n + round.pairs.length, 0);
    state.collapsedFunctionCallTokens = selectedRounds.reduce((n, round) => n + round.callTokens, 0);
    state.collapsedFunctionOutputTokens = selectedRounds.reduce((n, round) => n + round.outputTokens, 0);
    const droppedCodepoints = new Map();
    let droppedChars = 0;
    for (const image of images) {
        droppedChars += image.droppedChars;
        for (const [codepoint, count] of image.droppedCodepoints) {
            droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
        }
    }
    return {
        ...base,
        segments,
        images,
        imageSources,
        text,
        start: selectedIndices[0] ?? 0,
        endExclusive: (selectedIndices.at(-1) ?? -1) + 1,
        collapsedTurns: selectedIndices.length,
        collapsedChars: text.length,
        droppedChars,
        droppedCodepoints,
        selectedIndices,
        pairState: state,
    };
}
// ---- Public-summary checkpoints (opt-in; legacy planners above are unchanged)
function summaryMessageText(item, projectionVersion = 2) {
    if (!item || (item.type !== undefined && item.type !== 'message')
        || Object.keys(item).some(key => !['type', 'role', 'content', 'id', 'status',
            ...(projectionVersion >= 2 ? ['phase'] : [])].includes(key))
        || (Object.hasOwn(item, 'phase') && (item.role !== 'assistant'
            || ![null, 'commentary', 'final_answer'].includes(item.phase)))
        || (item.status !== undefined && item.status !== 'completed')
        || (item.id !== undefined && typeof item.id !== 'string')
        || isRenderedGptContext(item) || responseHasClientImages(item))
        return null;
    // Unlike the legacy broad projector, an unknown part with a text property is
    // still opaque protocol state, not permission to discard the original.
    if (Array.isArray(item.content) && item.content.some(part => !part
        || !['text', 'input_text', 'output_text', 'refusal'].includes(part.type)
        || (part.type === 'refusal' ? typeof part.refusal !== 'string' : typeof part.text !== 'string')
        || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length))))
        return null;
    const message = responseMessageText(item);
    if (!message && projectionVersion >= 3 && item.role === 'assistant' && isContentlessMessage(item))
        return { role: 'assistant', text: '', ...(typeof item.phase === 'string' ? { phase: item.phase } : {}) };
    return message && typeof item.phase === 'string'
        ? { ...message, phase: item.phase } : message;
}
function publicReasoningSummary(item, index, projectionVersion = 2) {
    // Never serialize, decode or tokenize encrypted_content. Unknown reasoning
    // payloads remain native; only the explicitly public summary field is read.
    if (!item || item.type !== 'reasoning'
        || Object.keys(item).some(key => !['type', 'id', 'status', 'summary', 'encrypted_content',
            ...(projectionVersion >= 3 ? ['content'] : [])].includes(key))
        || (item.id !== undefined && typeof item.id !== 'string')
        || (item.status !== undefined && item.status !== 'completed')
        || (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string'
            && !(projectionVersion >= 3 && item.encrypted_content === null))
        || (projectionVersion >= 3 && item.content !== undefined && (!Array.isArray(item.content)
            || item.content.some(part => !part || part.type !== 'reasoning_text' || typeof part.text !== 'string'
                || Object.keys(part).some(key => key !== 'type' && key !== 'text'))))
        || (item.summary !== undefined && !Array.isArray(item.summary)))
        return null;
    const notes = [];
    for (const part of item.summary ?? []) {
        if (!part || !['summary_text', 'text'].includes(part.type) || typeof part.text !== 'string'
            || Object.keys(part).some(key => key !== 'type' && key !== 'text'))
            return null;
        if (part.text.trim())
            notes.push(part.text);
    }
    return {
        text: notes.length ? `<assistant t="${index}" kind="reasoning-summary" notes="lossy public notes">\n${notes.join('\n\n')}\n</assistant>` : '',
        summaries: notes.length,
        baselineTokens: gptCountTokens(notes.join('\n\n')),
    };
}
/** Strip only explicitly typed child reasoning blocks in structured reports.
 * Ordinary strings (including prose mentioning "thinking") are never searched
 * or heuristically rewritten. Handles are returned separately so reportBlock's
 * head/tail clipping cannot discard a continuation token in the middle. */
const SUMMARY_CONTINUATION_KEYS = new Set([
    'sessionid', 'session_id', 'agent', 'agentid', 'agent_id',
    'task', 'taskid', 'task_id', 'resume', 'resumeid', 'resume_id', 'handle',
]);
function publicSubagentResult(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return { text, continuation: '' };
    }
    if (!value || typeof value !== 'object')
        return { text, continuation: '' };
    let changed = false;
    const continuation = [];
    const seenHandles = new Set();
    let handleChars = 0;
    const visit = (node) => {
        if (!node || typeof node !== 'object')
            return node;
        for (const [key, val] of Object.entries(node)) {
            // Explicit structured keys only; never scan prose for identifiers.
            // Keep exact bounded values, not clipped/invalid continuation IDs.
            if (!SUMMARY_CONTINUATION_KEYS.has(key.toLowerCase())
                || !(typeof val === 'string' && val.trim() && val.length <= 512
                    || typeof val === 'number' && Number.isSafeInteger(val)))
                continue;
            const encoded = safeJson(val);
            const identity = `${key.toLowerCase()}\0${encoded}`;
            const line = `${key}: ${encoded}`;
            if (!seenHandles.has(identity) && continuation.length < 32
                && handleChars + line.length <= 4096) {
                seenHandles.add(identity);
                continuation.push(line);
                handleChars += line.length;
            }
        }
        if (['reasoning', 'thinking', 'redacted_thinking'].includes(node.type)) {
            changed = true;
            const handles = Object.fromEntries(Object.entries(node).filter(([key, val]) =>
                /^(id|session_?id|agent_?id|task_?id|call_?id|resume_?id|handle)$/i.test(key)
                && (typeof val === 'string' || typeof val === 'number')));
            return Object.keys(handles).length ? handles : undefined;
        }
        if (Array.isArray(node))
            return node.map(visit).filter(part => part !== undefined);
        return Object.fromEntries(Object.entries(node).map(([key, val]) => [key, visit(val)])
            .filter(([, val]) => val !== undefined));
    };
    const result = visit(value);
    return {
        text: changed ? safeJson(result ?? '') : text,
        continuation: continuation.length ? `[Subagent continuation handles]\n${continuation.join('\n')}` : '',
    };
}
function summaryPairIsSafe(call, output, referenced, projectionVersion = 2) {
    const extended = projectionVersion >= 3;
    if (typeof call.name !== 'string' || !call.name.trim()) return false;
    if (Object.keys(call).some(key => !['type', 'id', 'call_id', 'name', 'namespace', 'arguments', 'input', 'status',
        ...(extended ? ['async', 'caller'] : [])].includes(key))
        || Object.keys(output).some(key => !['type', 'id', 'call_id', 'output', 'status',
            ...(extended ? ['name', 'namespace', 'caller'] : [])].includes(key)))
        return false;
    if (extended) {
        const direct = value => value === undefined || value === null
            || (typeof value === 'object' && !Array.isArray(value) && value.type === 'direct'
                && Object.keys(value).length === 1);
        if (!direct(call.caller) || !direct(output.caller)
            || (call.async !== undefined && call.async !== false)
            || (output.name !== undefined && (typeof output.name !== 'string'
                || ![call.name, call.name?.split('.').at(-1),
                    call.namespace ? `${call.namespace}.${call.name}` : call.name].includes(output.name)))
            || (output.namespace !== undefined && (typeof output.namespace !== 'string'
                || (call.namespace !== undefined && call.namespace !== output.namespace))))
            return false;
    }
    if ([call, output].some(item => responseHasClientImages(item)
        || [item?.id, item?.call_id].some(id => typeof id === 'string' && referenced.has(id))
        || (item?.id !== undefined && typeof item.id !== 'string')))
        return false;
    if (typeof call.name !== 'string' || !call.name.trim()
        || (call.namespace !== undefined && typeof call.namespace !== 'string')
        || (typeof output.output !== 'string'
            && (!Array.isArray(output.output) || historyContentText(output.output) === null)))
        return false;
    if (call.type === 'custom_tool_call')
        return typeof call.input === 'string';
    if (typeof call.arguments !== 'string')
        return false;
    try {
        const args = JSON.parse(call.arguments);
        return !!args && typeof args === 'object' && !Array.isArray(args)
            && (!extended || summaryCallProjection(call, output) !== null);
    }
    catch {
        return false;
    }
}
function summaryCallProjection(call, output = {}, depth = 0, budget = { count: 0 }) {
    if (depth > 4 || ++budget.count > 128) return null;
    const namespace = call.namespace ?? output.namespace;
    const qualified = namespace && !call.name.startsWith(`${namespace}.`)
        ? `${namespace}.${call.name}` : call.name;
    const leaf = call.name.split('.').at(-1);
    const args = call.type === 'custom_tool_call'
        ? { input: call.input, _raw: call.input } : parseArgs(call.arguments);
    if (qualified === 'multi_tool_use.parallel') {
        const uses = args.tool_uses;
        if (!Array.isArray(uses) || !uses.length || uses.length > 128) return null;
        const lines = [`[${qualified}] ${uses.length} child calls`];
        let subagent = false;
        for (const use of uses) {
            if (!use || typeof use.recipient_name !== 'string' || !use.recipient_name.trim()
                || !use.parameters || typeof use.parameters !== 'object' || Array.isArray(use.parameters)
                || Object.keys(use).some(key => !['recipient_name', 'parameters'].includes(key))) return null;
            const child = summaryCallProjection({ type: 'function_call', name: use.recipient_name,
                arguments: JSON.stringify(use.parameters) }, {}, depth + 1, budget);
            if (!child) return null;
            lines.push(child.text);
            subagent ||= child.subagent;
        }
        return { text: lines.join('\n'), leaf, subagent };
    }
    const lines = toolCallLines(leaf, args).map(line =>
        qualified !== leaf && line.startsWith(`[${leaf}]`)
            ? `[${qualified}]${line.slice(leaf.length + 2)}` : line);
    if (qualified !== leaf && !lines.some(line => line.includes(qualified)))
        lines.unshift(`[tool ${clip(qualified, MAX_CALL_CHARS)}]`);
    return { text: lines.join('\n'), leaf, subagent: SUBAGENT_TOOL_NAMES.has(leaf) };
}
// v4: a completed local Read can be reissued from this exact source locator.
// This is retirement by age/checkpoint, not a claim that a later read superseded it.
function retiredReadLocator(call, output) {
    if (!HISTORY_DROP_TOOLS || call?.type !== 'function_call'
        || call.name?.split('.').at(-1)?.toLowerCase() !== 'read') return null;
    const args = parseArgs(call.arguments);
    const path = args.file_path ?? args.filePath ?? args.path ?? args.file;
    const body = historyContentText(output?.output);
    if (typeof path !== 'string' || !path.trim() || /^(?:https?:|data:)/i.test(path)
        || body === null || body.length <= 200 || looksFailed(body)) return null;
    if ([args.offset, args.limit].some(value => value !== undefined
        && (!Number.isSafeInteger(value) || value < 0))) return null;
    const qualified = call.namespace && !call.name.startsWith(`${call.namespace}.`)
        ? `${call.namespace}.${call.name}` : call.name;
    return `[${qualified}] ${JSON.stringify(path)}`
        + (args.offset !== undefined ? ` offset=${args.offset}` : '')
        + (args.limit !== undefined ? ` limit=${args.limit}` : '')
        + ' [older Read output >200 chars omitted; re-read this range if needed]';
}
function summaryRoundProjection(round, items, offset = 0, projectionVersion = 2) {
    // Keep absolute source roles/indices, even when parallel outputs arrive in a
    // different order. The same toolCallLines/keptToolOutput policy is used, but
    // only a subagent's public result (never typed child thinking) is projected.
    const parts = new Map();
    for (const pair of round.pairs) {
        const call = items[pair.callIndex];
        const output = items[pair.outputIndex];
        const name = call.name;
        const projection = projectionVersion >= 3 ? summaryCallProjection(call, output) : null;
        const subagent = projectionVersion >= 3 ? projection?.subagent : SUBAGENT_TOOL_NAMES.has(name);
        const readLocator = projectionVersion >= 4 ? retiredReadLocator(call, output) : null;
        const lines = readLocator ?? (projectionVersion >= 3 ? projection?.text
            : responseRoundText(call, { ...output, output: '' }));
        if (lines)
            parts.set(pair.callIndex, `<assistant t="${pair.callIndex + offset}" kind="tool-call">\n${lines}\n</assistant>`);
        let body = historyContentText(output.output);
        let continuation = '';
        if (subagent) {
            const report = publicSubagentResult(body);
            body = report.text;
            continuation = report.continuation;
        }
        const outputName = subagent ? 'subagent' : name;
        const report = keptToolOutput(outputName, body)
            || (subagent && body.trim() && isLaunchAck(body) ? reportBlock('subagent', body) : '');
        const kept = [report, continuation].filter(Boolean).join('\n');
        if (kept)
            parts.set(pair.outputIndex, `<tool t="${pair.outputIndex + offset}">\n${kept}\n</tool>`);
    }
    if (projectionVersion >= 3) for (const index of round.interleavedIndices ?? []) {
        const msg = summaryMessageText(items[index], projectionVersion);
        if (msg?.text.trim())
            parts.set(index, `<${msg.role} t="${index + offset}"${msg.phase ? ` phase="${msg.phase}"` : ''}>\n${msg.text}\n</${msg.role}>`);
    }
    return [...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
}
function summaryDuplicateCallIds(items) {
    // Cheap prefix-wide protocol check. Bounded epoch classification must not
    // mistake a local pair for a unique pair when an older native item shares
    // its call_id. This never serializes or tokenizes any item.
    const calls = new Set();
    const outputs = new Set();
    const duplicates = new Set();
    for (const item of items) {
        const seen = isResponsesToolCall(item) ? calls : isResponsesToolOutput(item) ? outputs : null;
        const id = seen ? responseCallId(item) : '';
        if (!id)
            continue;
        if (seen.has(id))
            duplicates.add(id);
        seen.add(id);
    }
    return duplicates;
}
function summaryCheckpointUnits(items, referenced, anchor, offset, source, duplicateIds, projectionVersion) {
    // Only this epoch's unsealed source + lookahead is tokenized/projected.
    // Indices become absolute immediately, before grouping or rendering.
    const { completed } = classifyResponsesPairs(items, 0, projectionVersion >= 3);
    const rounds = new Map(completed.map(round => [round.startIndex, round]));
    const atoms = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const round = rounds.get(i);
        if (round) {
            // The legacy classifier can discover a valid suffix after a native
            // call, or a prefix before an orphan output. Neither is a complete
            // parallel batch. Do not split off that apparently valid subset.
            const nativeBetween = round.safeProtocol === false || (round.interleavedIndices ?? []).some(index =>
                items[index]?.role !== 'assistant' || summaryMessageText(items[index], projectionVersion) === null);
            const safe = !isResponsesToolCall(source[offset + i - 1])
                && !isResponsesToolOutput(items[round.endIndex + 1])
                && !nativeBetween
                && round.pairs.every(pair => !duplicateIds.has(responseCallId(items[pair.callIndex]))
                    && summaryPairIsSafe(items[pair.callIndex], items[pair.outputIndex], referenced, projectionVersion))
                && (round.interleavedIndices ?? []).every(index => !referenced.has(items[index]?.id));
            const absoluteRound = {
                ...round,
                startIndex: round.startIndex + offset, endIndex: round.endIndex + offset,
                indices: round.indices.map(index => index + offset),
                pairs: round.pairs.map(pair => ({ ...pair,
                    callIndex: pair.callIndex + offset, outputIndex: pair.outputIndex + offset })),
            };
            atoms.push({
                start: i + offset, endExclusive: round.endIndex + offset + 1, indices: absoluteRound.indices,
                safe, text: safe ? summaryRoundProjection(round, items, offset, projectionVersion) : '',
                nativeReason: safe ? null : round.pairs.some(pair =>
                    responseHasClientImages(items[pair.callIndex]) || responseHasClientImages(items[pair.outputIndex]))
                    ? 'client_image' : nativeBetween ? 'native_interleaved_state' : 'native_tool_shape',
                baselineTokens: round.callTokens + round.outputTokens
                    + (round.interleavedIndices ?? []).reduce((n, index) =>
                        n + gptCountTokens(summaryMessageText(items[index], projectionVersion)?.text ?? ''), 0),
                rounds: [absoluteRound],
                retiredReads: projectionVersion >= 4 && safe
                    && !(round.interleavedIndices ?? []).length
                    && round.pairs.every(pair => retiredReadLocator(items[pair.callIndex], items[pair.outputIndex]) !== null),
                reasoning: [], summaries: 0,
            });
            i = round.endIndex;
            continue;
        }
        const isReasoning = item?.type === 'reasoning';
        const index = i + offset;
        const note = isReasoning ? publicReasoningSummary(item, index, projectionVersion) : null;
        const msg = !isReasoning ? summaryMessageText(item, projectionVersion) : null;
        const safe = index !== anchor && !referenced.has(item?.id)
            && (isReasoning ? note !== null : msg !== null);
        atoms.push({
            start: index, endExclusive: index + 1, indices: [index], safe,
            nativeReason: safe ? null : referenced.has(item?.id) ? 'native_reference'
                : responseHasClientImages(item) ? 'client_image'
                : isReasoning ? 'native_reasoning_shape'
                : projectionVersion === 1 && item?.role === 'assistant'
                    && ['commentary', 'final_answer'].includes(item.phase) ? 'assistant_phase_legacy'
                : 'native_message_shape',
            text: safe ? (note?.text ?? (msg.text.trim()
                ? `<${msg.role} t="${index}"${msg.phase ? ` phase="${msg.phase}"` : ''}>\n${msg.text}\n</${msg.role}>` : '')) : '',
            baselineTokens: note?.baselineTokens ?? (msg ? gptCountTokens(msg.text) : 0),
            reasoning: isReasoning ? [index] : [], summaries: note?.summaries ?? 0, rounds: [],
        });
    }
    const units = [];
    for (let i = 0; i < atoms.length; i++) {
        const first = atoms[i];
        if (!first.reasoning.length) {
            units.push(first);
            continue;
        }
        // A reasoning item belongs to its response AND following tool round(s),
        // up to the next user/authority or next response's reasoning. A native
        // call/output/unknown/reference anywhere in that unit protects it all.
        // Consecutive reasoning items are separate responses too: an opaque-only
        // history must not become one unbounded, permanently unsealable unit.
        const group = [first];
        while (i + 1 < atoms.length) {
            const next = atoms[i + 1];
            const item = source[next.start];
            if (['user', 'system', 'developer'].includes(item?.role)
                || next.reasoning.length)
                break;
            group.push(next);
            i++;
        }
        units.push({
            start: first.start, endExclusive: group.at(-1).endExclusive,
            indices: group.flatMap(atom => atom.indices), safe: group.every(atom => atom.safe),
            nativeReason: group.find(atom => !atom.safe)?.nativeReason ?? null,
            text: group.map(atom => atom.text).filter(Boolean).join('\n\n'),
            baselineTokens: group.reduce((n, atom) => n + atom.baselineTokens, 0),
            reasoning: group.flatMap(atom => atom.reasoning),
            summaries: group.reduce((n, atom) => n + atom.summaries, 0),
            rounds: group.flatMap(atom => atom.rounds),
        });
    }
    return { units };
}
/**
 * Independent original-source epochs, never a rolling/repacked prefix. Each
 * epoch sees the same fixed target+tail snapshot on every append-only request.
 * Correction: targets stay on the original grid, but each source range starts
 * at the previous safe cut. A crossing unit is deferred and carried whole into
 * a later epoch, NOT permanently pinned native. Already-sealed pages never
 * change. Genuinely unsafe/referenced units remain native.
 * `closedThrough` is exclusive; summaryState fields are counts and epochs are
 * {start,target,closedThrough,removed,summaries,protected}. Epoch protected counts
 * include that epoch's deferred units; the aggregate counts final native items
 * only, without double-counting repeated carries.
 */
export async function planResponsesSummaryCollapse(items, isProfitable, opts = {}) {
    opts = opts && typeof opts === 'object' ? opts : {};
    const o = { ...GPT_HISTORY_DEFAULTS, ...opts };
    const integer = (value, fallback) => Number.isFinite(value) ? Math.floor(value) : fallback;
    const chunk = integer(opts.checkpointChunk, 50);
    const tail = Math.max(30, integer(opts.keepTail, 30));
    const maxImages = Math.max(0, integer(o.maxImages, 0));
    const summaryState = { removed: 0, summaries: 0, protected: 0, closedThrough: 0, epochs: [] };
    const base = { ...emptyResponsesPairPlan(classifyResponsesPairs([], 0).state), summaryState };
    if (!Array.isArray(items))
        return { ...base, reason: 'invalid_input' };
    // Full-request telemetry is measured once, not once per historical epoch.
    const projectionVersion = opts.projectionVersion ?? 3;
    const allPairs = classifyResponsesPairs(items, 0, projectionVersion >= 3);
    base.pairState = allPairs.state;
    if (chunk <= 1)
        return { ...base, reason: 'no_closed_prefix' };
    let limit = Math.max(0, items.length - tail);
    if (opts.checkpointCutoff !== undefined)
        limit = Math.min(limit, Math.max(0, integer(opts.checkpointCutoff, 0)));
    const cutoff = Math.floor(limit / chunk) * chunk;
    if (!cutoff)
        return { ...base, reason: 'no_closed_prefix' };
    const anchor = items.findIndex(item => item?.role === 'user' && !isRenderedGptContext(item));
    // References always win, including references to old items in the live tail.
    const referenced = responseReferencedIds(items);
    const failSafe = reason => ({
        ...base, reason,
        summaryState: { removed: 0, summaries: 0, protected: 0, closedThrough: 0, epochs: [] },
    });
    const segments = [];
    const selectedRounds = [];
    const removed = new Set();
    const nativePairReasons = new Map();
    let imageCount = 0;
    let pairState = base.pairState;
    let start = 0;
    for (let target = chunk; target <= cutoff; target += chunk) {
        const frameEnd = Math.min(items.length, target + tail);
        const prefix = items.slice(0, frameEnd);
        const frameReferences = responseReferencedIds(prefix);
        const classified = summaryCheckpointUnits(items.slice(start, frameEnd),
            frameReferences, anchor, start, items, summaryDuplicateCallIds(prefix),
            projectionVersion);
        for (const unit of classified.units) if (!unit.safe)
            for (const round of unit.rounds)
                nativePairReasons.set(round.startIndex, unit.nativeReason ?? 'native_dependency');
        const crossing = classified.units.filter(unit => unit.start < target && unit.endExclusive > target);
        const closedThrough = Math.min(target, ...crossing.map(unit => unit.start));
        const eligible = classified.units.filter(unit => unit.safe && unit.start >= start
            && unit.endExclusive <= closedThrough);
        // A later reference changes the semantic dependencies of a sealed
        // epoch. It is impossible both to preserve that reference natively and
        // replay its old image unchanged: decline atomically, never repack it.
        if (eligible.some(unit => unit.indices.some(index =>
            [items[index]?.id, items[index]?.call_id].some(id =>
                typeof id === 'string' && referenced.has(id) && !frameReferences.has(id)))))
            return failSafe('summary_native_reference');
        const reasoningEpoch = eligible.some(unit => unit.reasoning.length);
        const runs = [];
        for (const unit of eligible) {
            const run = runs.at(-1);
            if (run && run.at(-1).endExclusive === unit.start
                && (projectionVersion < 4 || !!run.at(-1).retiredReads === !!unit.retiredReads))
                run.push(unit);
            else
                runs.push([unit]);
        }
        let epochSummaries = 0;
        let epochRemoved = 0;
        for (const run of runs) {
            const source = run.map(unit => unit.text).filter(Boolean).join('\n\n');
            const baselineTokens = run.reduce((n, unit) => n + unit.baselineTokens, 0);
            const safe = neutralizeSentinel(source);
            const renderedText = o.reflow ? reflow(safe) ?? safe : safe;
            const cols = o.reflow ? o.cols : measureContentCols(renderedText, o.cols, o.style?.markerScale, o.style?.font);
            // Successful old Read output >200 chars is explicitly disposable.
            // Do not reimpose a 30k history floor or a per-page profit veto here.
            // The outer cache controller still owns when this version is committed.
            const retiredReads = projectionVersion >= 4 && run.every(unit => unit.retiredReads);
            // V5 follows Claude: project completed old tools in this pass, then
            // let the outer whole-request gate decide whether to commit. A tiny
            // individual run must not veto a useful complete checkpoint.
            // Replay older projection versions with their original gates.
            if (projectionVersion < 5 && !reasoningEpoch && !retiredReads && (baselineTokens < o.minCollapseTokens
                || (source && typeof isProfitable === 'function'
                    && !await isProfitable(renderedText, cols, baselineTokens, source))))
                continue;
            if (source && imageCount >= maxImages) {
                return failSafe('summary_image_budget');
            }
            const images = source ? await renderTextToPngs(renderedText, cols,
                o.style ?? DEFAULT_GPT_PROFILE.style, o.maxHeightPx) : [];
            if ((source && !images.length) || imageCount + images.length > maxImages) {
                // Atomic fail-safe: never return a shortened/re-rendered old
                // epoch prefix when a later page exhausts the request budget.
                return failSafe('summary_image_budget');
            }
            const selectedIndices = run.flatMap(unit => unit.indices);
            segments.push({
                insertAt: selectedIndices[0], selectedIndices, images,
                imageSources: images.map(() => source), text: source, baselineTokens,
            });
            imageCount += images.length;
            for (const unit of run) {
                unit.reasoning.forEach(index => removed.add(index));
                epochRemoved += unit.reasoning.length;
                epochSummaries += unit.summaries;
                selectedRounds.push(...unit.rounds);
            }
        }
        let protectedCount = 0;
        for (let i = start; i < target; i++)
            if (items[i]?.type === 'reasoning' && !removed.has(i))
                protectedCount++;
        summaryState.epochs.push({ start, target, closedThrough,
            removed: epochRemoved, summaries: epochSummaries, protected: protectedCount });
        summaryState.removed += epochRemoved;
        summaryState.summaries += epochSummaries;
        summaryState.closedThrough = closedThrough;
        start = closedThrough;
    }
    for (let i = 0; i < cutoff; i++)
        if (items[i]?.type === 'reasoning' && !removed.has(i))
            summaryState.protected++;
    const selectedIndices = segments.flatMap(segment => segment.selectedIndices);
    const images = segments.flatMap(segment => segment.images);
    const text = segments.map(segment => segment.text).filter(Boolean).join('\n\n');
    pairState.collapsedPairs = selectedRounds.reduce((n, round) => n + round.pairs.length, 0);
    pairState.collapsedFunctionCallTokens = selectedRounds.reduce((n, round) => n + round.callTokens, 0);
    pairState.collapsedFunctionOutputTokens = selectedRounds.reduce((n, round) => n + round.outputTokens, 0);
    const selectedCalls = new Set(selectedRounds.flatMap(round => round.pairs.map(pair => pair.callIndex)));
    summaryState.nativeToolPairReasons = {};
    for (const round of allPairs.completed) {
        const remaining = round.pairs.filter(pair => !selectedCalls.has(pair.callIndex)).length;
        if (!remaining) continue;
        const reason = round.endIndex >= cutoff ? 'live_tail'
            : nativePairReasons.get(round.startIndex) ?? 'native_dependency';
        summaryState.nativeToolPairReasons[reason] = (summaryState.nativeToolPairReasons[reason] ?? 0) + remaining;
    }
    const droppedCodepoints = new Map();
    let droppedChars = 0;
    for (const image of images) {
        droppedChars += image.droppedChars;
        for (const [codepoint, count] of image.droppedCodepoints)
            droppedCodepoints.set(codepoint, (droppedCodepoints.get(codepoint) ?? 0) + count);
    }
    return {
        ...base, segments, images, imageSources: segments.flatMap(segment => segment.imageSources),
        selectedIndices, text, baselineTokens: segments.reduce((n, segment) => n + segment.baselineTokens, 0),
        start: selectedIndices[0] ?? 0, endExclusive: (selectedIndices.at(-1) ?? -1) + 1,
        collapsedTurns: selectedIndices.length, collapsedChars: text.length, droppedChars, droppedCodepoints,
        pairState, summaryState, ...(selectedIndices.length ? {} : { reason: 'no_closed_prefix' }),
    };
}
// ---- Chat Completions lowering ----------------------------------------------
function chatContentToText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const p of content) {
        if (!p || typeof p !== 'object')
            continue;
        const t = p.type;
        if (t === 'text') {
            const txt = p.text;
            if (typeof txt === 'string')
                parts.push(txt);
        }
        else if (isHistoryImagePart(p)) {
            parts.push(imageHistoryMarker(p));
        }
    }
    return parts.join('\n');
}
function chatMessageToTurn(msg, idx, ctx, opts) {
    const o = (msg ?? {});
    const role = typeof o.role === 'string' ? o.role : '';
    const hasImage = Array.isArray(o.content) && o.content.some(isHistoryImagePart);
    const unknown = Array.isArray(o.content) && o.content.some((p) =>
        !p || (p.type !== 'text' && !isHistoryImagePart(p)) || (p.type === 'text' && typeof p.text !== 'string'));
    // Authority is not ordinary conversation history. A contiguous Chat
    // collapse must stop before it, even for empty or image-bearing content,
    // so the original role, ordering, parts and metadata stay on the wire.
    const opaque = role === 'system' || role === 'developer' || unknown ||
        isRenderedGptContext(o) || (hasImage && !opts.collapseImages);
    const body = chatContentToText(o.content);
    if (role === 'tool') {
        const id = typeof o.tool_call_id === 'string' ? o.tool_call_id : '';
        const raw = `[tool_result]\n${body}`;
        if (ctx?.dropTools && !opaque) {
            return {
                text: keptToolOutput(ctx.names.get(id) ?? 'tool', body) || imageHistoryNotes(o.content),
                rawText: raw,
                openIds: [],
                closeIds: id ? [id] : [],
                opaque: false,
            };
        }
        return {
            text: raw,
            openIds: [],
            closeIds: id ? [id] : [],
            opaque,
        };
    }
    if (role === 'assistant') {
        const openIds = [];
        const parts = [];
        const rawParts = [];
        if (body.trim()) {
            parts.push(body);
            rawParts.push(body);
        }
        const tc = o.tool_calls;
        if (Array.isArray(tc)) {
            for (const call of tc) {
                const c = (call ?? {});
                const id = typeof c.id === 'string' ? c.id : '';
                if (id)
                    openIds.push(id);
                const fn = c.function;
                const name = fn && typeof fn.name === 'string' ? fn.name : 'tool';
                const args = fn && typeof fn.arguments === 'string' ? fn.arguments : safeJson(fn?.arguments);
                rawParts.push(`[tool_use ${name}]\n${args}`);
                if (ctx?.dropTools) parts.push(...toolCallLines(name, parseArgs(fn?.arguments), { seen: ctx.seen }));
                else parts.push(`[tool_use ${name}]\n${args}`);
            }
        }
        const text = parts.join('\n');
        const rawJoined = rawParts.join('\n');
        return {
            text: text.trim() ? `<assistant t="${idx}">\n${text}\n</assistant>` : '',
            rawText: ctx?.dropTools && rawJoined.trim() ? `<assistant t="${idx}">\n${rawJoined}\n</assistant>` : undefined,
            openIds,
            closeIds: [],
            opaque,
        };
    }
    if (!body.trim())
        return { text: '', openIds: [], closeIds: [], opaque };
    const tag = role === 'user' ? 'user' : role || 'user';
    return {
        text: `<${tag} t="${idx}">\n${body}\n</${tag}>`,
        openIds: [],
        closeIds: [],
        opaque,
        userText: role === 'user' ? body : undefined,
    };
}
export function chatMessagesToTurns(messages, opts = {}) {
    let ctx;
    if (opts.dropTools && HISTORY_DROP_TOOLS) {
        const names = new Map();
        for (const m of messages) {
            if (m && typeof m === 'object' && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
                for (const c of m.tool_calls) {
                    if (c && typeof c.id === 'string' && c.function && typeof c.function.name === 'string') names.set(c.id, c.function.name);
                }
            }
        }
        ctx = { dropTools: true, names, seen: new Set() };
    }
    return messages.map((msg, i) => chatMessageToTurn(msg, i, ctx, opts));
}
function responsesItemToTurn(item, idx) {
    const o = (item ?? {});
    const type = responseItemType(item);
    const callId = responseCallId(item);
    if (type === 'function_call_output') {
        return {
            text: responseOutputText(o),
            openIds: [],
            closeIds: callId ? [callId] : [],
            opaque: false,
        };
    }
    if (type === 'function_call') {
        return {
            text: responseCallText(o),
            openIds: callId ? [callId] : [],
            closeIds: [],
            opaque: false,
        };
    }
    const msgText = responseMessageText(item);
    if (msgText) {
        const { role, text } = msgText;
        const tag = role === 'user' ? 'user' : 'assistant';
        return {
            text: `<${tag} t="${idx}">\n${text}\n</${tag}>`,
            openIds: [],
            closeIds: [],
            opaque: false,
            userText: role === 'user' ? text : undefined,
        };
    }
    return { text: '', openIds: [], closeIds: [], opaque: false };
}
export function responsesItemsToTurns(items) {
    return items.map((item, i) => responsesItemToTurn(item, i));
}
//# sourceMappingURL=openai-history.js.map
