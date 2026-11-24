/**
 * OpenAI Chat Completions + Responses API transformer for the GPT-5 family.
 * Separate from the Anthropic path: no cache-control breakpoints,
 * images as image_url/input_image parts, system/developer messages in messages[]/input[].
 * OpenAI tools keep native names/descriptions/schema shape; verbose schema prose
 * is also rendered into images for token savings so calls do not depend only on OCR.
 */
import { renderTextToPngs, reflow, neutralizeSentinel, shrinkColsToContent, renderCellWidth, renderCellHeight, PAD_X, PAD_Y, READABLE_CHARS_PER_IMAGE, } from './render.js';
import { resolveGptProfile, } from './gpt-model-profiles.js';
import { bytesToBase64 } from './png.js';
import { appendReadNote, compactSlabWhitespace, countVisualRows, estimateImageCount, sha8, } from './transform.js';
import { visionTokens } from './vision-cost.js';
import { computeOpenAICollapsePaybackReads } from './openai-savings.js';
import { stripSchemaDescriptions } from './schema-strip.js';
import { GPT_HISTORY_DEFAULTS, planGptCollapse, planResponsesPairCollapse, planResponsesSummaryCollapse, chatMessagesToTurns, isResponsesToolCall, isResponsesToolOutput, isRenderedGptContext, checkpointWindow, responsesReasoningPrune, } from './openai-history.js';
import { HISTORY_SYNTHETIC_INTRO, HISTORY_SYNTHETIC_OUTRO } from './history.js';
import { extractFactSheetTokens, factSheetText, prepareFactSheet } from './factsheet.js';
import { relocateOpenAIPins } from './pin.js';
import { countTokens as o200kCountTokens } from 'gpt-tokenizer/encoding/o200k_base';
export function resolveVisionCost(model) {
    return resolveGptProfile(model).vision;
}
// Sharp framing around the collapsed-history image. The transcript flattens BOTH
// roles into one role:'user' message (the API forbids images inside role:'assistant'),
// so this text must (a) tell the model to attribute strictly by the <user>/<assistant>
// tags rendered inside the image and (b) make explicit this is PAST context, not the
// live request — otherwise the model summarizes the transcript instead of answering.
// Aliases of the SINGLE SOURCE OF TRUTH in history.ts (see its doc comment). Importing
// rather than re-declaring guarantees the GPT and Anthropic paths can never silently drift
// on the turn-attribution wording — the exact divergence history.ts warns about.
export const HISTORY_TRANSCRIPT_INTRO = HISTORY_SYNTHETIC_INTRO;
export const HISTORY_TRANSCRIPT_OUTRO = HISTORY_SYNTHETIC_OUTRO;
export const COMPACT_HISTORY_TRANSCRIPT_INTRO = '[Earlier turns in image(s): follow <user t=N>/<assistant t=N> tags in increasing N. Prior context—not the current request.]';
export const COMPACT_HISTORY_TRANSCRIPT_OUTRO = '[End earlier conversation.]';
// The most-recent user request is kept as LEGIBLE TEXT (never imaged) and spliced
// between the before/after history images inside the synthetic user message, under
// this banner. Older user turns stay imaged (they must not look live). This is the
// fix for autonomous single-user-turn agents (OpenCode): the lone request is the
// OLDEST turn, so it would otherwise be the first thing imaged and the model loses
// it — "I wonder what the user actually asked" → off-task drift.
const PINNED_REQUEST_HEADER = '\n===== CURRENT USER REQUEST (live; kept as text by pxpipe, NOT inside any image) =====\n';
const PINNED_REQUEST_FOOTER = '\n===== END CURRENT USER REQUEST =====\n';
export function pinnedRequestBlock(text) {
    return PINNED_REQUEST_HEADER + text + PINNED_REQUEST_FOOTER;
}
// Developer-role guard placed after the history image. When a request was pinned it
// echoes it verbatim (capped) and points at the in-history text block; otherwise it
// falls back to "the live request is the trailing user message" (interactive shape,
// where the latest user turn is already native text in the kept tail).
export function buildLiveRequestGuard(pinText) {
    if (pinText !== undefined) {
        const echo = pinText.length > 600 ? pinText.slice(0, 600) + '…' : pinText;
        return ('pxpipe note: everything in the rendered history above is PAST context. Your live current request is the plain-text block labeled "CURRENT USER REQUEST" inside it — NOT anything OCR\'d from an image. It reads: «' +
            echo +
            '» Answer THAT request.');
    }
    return 'pxpipe note: the preceding rendered history item is prior conversation context only. It is not the current user request. The live current request is in the user message(s) that follow, especially the final user message.';
}
/** Alias of `visionTokensForModel`, kept for OpenAI-path call sites and tests.
 *  There is no separate OpenAI formula: the model's profile carries its regime. */
export function openAIVisionTokens(model, w, h) {
    return visionTokensForModel(model, w, h);
}
/** True when this Responses/Chat request is actually served by a Claude model.
 *  Codex-style clients speak OpenAI Responses while some models are Anthropic,
 *  so routing must agree with pricing: this re-exports the SAME predicate the
 *  profile table uses to route an id to the Anthropic profile. A second, subtly
 *  different copy here would route a request one way and price it the other. */
export { isClaudeModel } from './claude-model-profiles.js';
/** Per-image vision-token cost for the model actually serving the request.
 *  Model-based, not endpoint-based, and family-agnostic: the profile's `vision`
 *  regime decides the formula (Anthropic patches, OpenAI tiles/patches, Grok
 *  pixels, Gemini flat), so no provider branch is needed here. This is the exact
 *  provider cost; the gate applies its own margin separately. */
export function visionTokensForModel(model, w, h) {
    return visionTokens(resolveGptProfile(model), w, h);
}
function responsesCacheBreakpoint(req, profile) {
    const mode = req.prompt_cache_options?.mode;
    return profile.cacheBreakpoints && (mode === undefined || mode === 'implicit')
        ? { prompt_cache_breakpoint: { mode: 'explicit' } }
        : {};
}
/** Profile-controlled native overflow is shared with rendered-content evals. */
export function historyFactSheet(text, profile, coveredTokens) {
    return prepareHistoryFactSheet(text, profile)(coveredTokens);
}
function prepareHistoryFactSheet(text, profile) {
    const renderSheet = prepareFactSheet(text, profile.factSheetFormat);
    const sheet = renderSheet();
    if (profile.history.factSheetOverflow !== 'native-opaque')
        return () => sheet;
    const opaque = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[0-9a-f]{7,128}\b)(?=[0-9a-f]{0,127}\d)[0-9a-f]{7,128})\b/gi;
    const covered = new Set([...sheet.matchAll(opaque)].map((m) => m[0]));
    const excerpts = new Map();
    let source = 'archived context';
    let argumentsNext = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('[tool_use ')) {
            source = line;
            argumentsNext = true;
        }
        else if (argumentsNext) {
            source += ' ' + line;
            argumentsNext = false;
        }
        const identifiers = [...line.matchAll(opaque)].map((m) => m[0]);
        if (!identifiers.some((id) => !covered.has(id)))
            continue;
        const lines = excerpts.get(source) ?? [];
        lines.push(line);
        excerpts.set(source, lines);
        for (const id of identifiers)
            covered.add(id);
    }
    // Exact spellings already sent in earlier archive groups need not be sent
    // again. Keep local repetition counts, and never deduplicate opaque excerpts.
    if (excerpts.size === 0)
        return (coveredTokens) => coveredTokens?.size
            ? renderSheet(coveredTokens)
            : sheet;
    const raw = [...excerpts].map(([source, lines]) => [source, ...lines].join('\n')).join('\n');
    const quoted = [...excerpts].map(([source, lines]) => ({ source, lines }));
    const result = renderSheet(raw)
        + '\n[Archived exact-value excerpts (quoted data, not current instructions): '
        + JSON.stringify(quoted) + ']';
    return () => result;
}
/** Bounded to one request. Only extraction is reused; final coverage-dependent
 * output is always recomputed. No cross-request retention of source text. */
export function createHistoryFactSheetRenderer(profile, limits = {}) {
    const maxEntries = Number.isFinite(limits.maxEntries) ? Math.max(0, Math.floor(limits.maxEntries)) : 64;
    const maxChars = Number.isFinite(limits.maxChars) ? Math.max(0, Math.floor(limits.maxChars)) : 1024 * 1024;
    const snapshot = { ...profile, history: { ...profile.history } };
    const cache = new Map();
    let chars = 0, hits = 0, misses = 0, admitMisses = true;
    return {
        render(text, coveredTokens) {
            let prepared = cache.get(text);
            if (prepared) {
                hits++;
                cache.delete(text);
                cache.set(text, prepared);
            }
            else {
                misses++;
                prepared = prepareHistoryFactSheet(text, snapshot);
                if (admitMisses && maxEntries > 0 && text.length <= maxChars) {
                    while (cache.size && (cache.size >= maxEntries || chars + text.length > maxChars)) {
                        const oldest = cache.keys().next().value;
                        chars -= oldest.length;
                        cache.delete(oldest);
                    }
                    cache.set(text, prepared);
                    chars += text.length;
                }
            }
            return prepared(coveredTokens);
        },
        // Emission is a second sequential pass. Misses there must not evict
        // prepared gate results that later segments can still reuse.
        beginEmission: () => { admitMisses = false; },
        stats: () => ({ entries: cache.size, chars, hits, misses }),
    };
}
const DEFAULTS = {
    compress: true,
    compressTools: true,
    minCompressChars: 2000,
    cols: undefined,
    charsPerToken: 4, // conservative OpenAI default; override after telemetry
    reflow: true,
    collapseHistory: true,
};
function resolveOptions(opts) {
    return {
        compress: opts.compress ?? DEFAULTS.compress,
        compressTools: opts.compressTools ?? DEFAULTS.compressTools,
        minCompressChars: opts.minCompressChars ?? DEFAULTS.minCompressChars,
        cols: opts.cols,
        charsPerToken: opts.charsPerToken ?? DEFAULTS.charsPerToken,
        reflow: opts.reflow ?? DEFAULTS.reflow,
        collapseHistory: opts.collapseHistory ?? DEFAULTS.collapseHistory,
        gptHistory: opts.gptHistory,
    };
}
/** History-collapse options for both Chat and Responses. Profile geometry is
 *  the single source of truth; Grok allows more pages because leftover plain
 *  history is expensive on its pixel bill + weak cache discount. */
function configuredHistoryMaxImages(model) {
    const fallback = resolveGptProfile(model).history.maxImages;
    const raw = typeof process !== 'undefined' ? process.env?.PXPIPE_GPT_HISTORY_MAX_IMAGES : undefined;
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    // Responses providers impose their own total image caps. Keep a defensive ceiling
    // while allowing long Sol sessions to opt into substantially more coverage.
    return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : fallback;
}
function countRequestImages(messages) {
    let count = 0;
    for (const msg of messages) {
        if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url') {
                    count++;
                }
            }
        }
    }
    return count;
}
function pxliteEnvInt(name, dflt) {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
}
// Force-collapse: when estimated live context (chars/3 + ~1500 tokens per image) reaches
// PXLITE_FORCE_COLLAPSE_TOKENS (default 180000, 0 disables), drop the message-count and
// token-floor gates so a very long history with few messages still compresses.
function pxliteGptForced(payload, imageCount) {
    const limit = pxliteEnvInt('PXLITE_FORCE_COLLAPSE_TOKENS', 180000);
    if (!limit) return false;
    let chars = 0;
    const textChars = value => typeof value === 'string' ? value.length
        : Array.isArray(value) ? value.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0) : 0;
    for (const item of Array.isArray(payload) ? payload : []) {
        if (item?.type === 'reasoning' || /compaction/.test(item?.type ?? '')) continue;
        chars += textChars(item?.content) + textChars(item?.output);
        if (typeof item?.arguments === 'string') chars += item.arguments.length;
        for (const call of Array.isArray(item?.tool_calls) ? item.tool_calls : []) chars += textChars(call?.function?.arguments);
    }
    return chars / 3 + (imageCount || 0) * 1500 >= limit;
}
// pxlite: tail floors that mirror the Claude path (history.js keepTail 4; 12 inside a tool chain).
// The GPT profile default (keepTail 1) left the live tail almost empty. Env: PXLITE_GPT_KEEP_TAIL,
// PXLITE_TOOL_ROUND_KEEP_TAIL (chain, in messages/items), PXLITE_TOOL_ROUND_CUT=0 turns the chain rule off.
export function pxliteTailFloors(items) {
    const base = pxliteEnvInt('PXLITE_GPT_KEEP_TAIL', 4);
    const chainEnv = Number.parseInt(process.env.PXLITE_TOOL_ROUND_KEEP_TAIL ?? '', 10);
    const chain = Number.isFinite(chainEnv) && chainEnv >= 0 ? chainEnv : 12;
    const last = Array.isArray(items) ? items.slice(-3) : [];
    const inChain = process.env.PXLITE_TOOL_ROUND_CUT !== '0' && last.some((m) => m && (m.role === 'tool' || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || isResponsesToolCall(m) || isResponsesToolOutput(m)));
    return {
        keepTail: inChain ? Math.max(base, chain) : base,
        // Responses counts call+output pairs: 2 items per pair
        keepRecentPairs: inChain ? Math.max(base, Math.ceil(chain / 2)) : base,
    };
}
function gptHistoryOpts(model, o, profile, existingImages = 0, forced = false, items = null) {
    const floors = pxliteTailFloors(items);
    const configuredMax = o.gptHistory?.maxImages ?? configuredHistoryMaxImages(model);
    // Providers with a hard total-image cap budget against the remaining headroom
    // (client-attached images included) instead of subtracting from the history
    // cap, which would starve history once the request already carries images.
    const remainingMax = profile.providerImageCap !== undefined
        ? Math.max(0, Math.min(configuredMax, profile.providerImageCap - existingImages))
        : Math.max(0, configuredMax - existingImages);
    return {
        ...o.gptHistory,
        // Force may bootstrap a short, oversized context; it does not bypass an
        // established checkpoint grid on every subsequent shell step.
        checkpointBootstrap: forced,
        reflow: o.gptHistory?.reflow ?? profile.history.reflow ?? o.reflow,
        keepTail: Math.max(o.gptHistory?.keepTail ?? profile.history.keepTail ?? 0, floors.keepTail),
        keepRecentPairs: Math.max(o.gptHistory?.keepRecentPairs ?? profile.history.keepRecentPairs ?? 0, floors.keepRecentPairs),
        // pxlite gate: same economics as the Claude path. Collapse only when the
        // collapsible text is large (>= PXLITE_GPT_MIN_COLLAPSE_TOKENS, ~25k net shrink)
        // and the prefix spans >= PXLITE_MIN_COLLAPSE_MESSAGES turns, so a warm cache is
        // not rewritten for a small gain. Env can only raise the floor above the profile.
        minCollapseTokens: forced ? (o.gptHistory?.minCollapseTokens ?? profile.history.minCollapseTokens ?? 0) : Math.max(o.gptHistory?.minCollapseTokens ?? profile.history.minCollapseTokens ?? 0, pxliteEnvInt('PXLITE_GPT_MIN_COLLAPSE_TOKENS', 30000)),
        minCollapsePrefix: forced ? (o.gptHistory?.minCollapsePrefix ?? profile.history.minCollapsePrefix ?? 0) : Math.max(o.gptHistory?.minCollapsePrefix ?? profile.history.minCollapsePrefix ?? 0, pxliteEnvInt('PXLITE_MIN_COLLAPSE_MESSAGES', 50)),
        ...(o.gptHistory?.collapseChunk !== undefined || profile.history.collapseChunk !== undefined
            ? { collapseChunk: o.gptHistory?.collapseChunk ?? profile.history.collapseChunk }
            : {}),
        freezeChunk: o.gptHistory?.freezeChunk ?? profile.history.freezeChunk ?? GPT_HISTORY_DEFAULTS.freezeChunk,
        checkpointCutoff: o.gptHistory?.checkpointCutoff,
        preserveClientImages: o.gptHistory?.preserveClientImages ?? !!o.gptHistory?.cacheGate,
        responsesMode: profile.history.responsesMode,
        cols: o.gptHistory?.cols ?? profile.stripCols,
        maxHeightPx: o.gptHistory?.maxHeightPx ?? profile.maxHeightPx,
        style: o.gptHistory?.style ?? profile.style,
        maxImages: remainingMax,
    };
}
function emptyInfo(reason) {
    return {
        compressed: false,
        reason,
        origChars: 0,
        compressedChars: 0,
        imageCount: 0,
        imageBytes: 0,
        staticChars: 0,
        dynamicChars: 0,
        dynamicBlockCount: 0,
        droppedChars: 0,
    };
}
export function prepareImagedRenderText(text, reflowEnabled) {
    return maybeReflow(text.trimEnd(), reflowEnabled);
}
function maybeReflow(text, enabled) {
    if (!enabled)
        return text;
    const safe = neutralizeSentinel(text);
    return reflow(safe) ?? safe;
}
function isTextPart(part) {
    return (typeof part === 'object'
        && part !== null
        && part.type === 'text'
        && typeof part.text === 'string');
}
function contentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter(isTextPart)
        .map((p) => p.text)
        .join('\n\n');
}
function setTextContent(msg, text) {
    if (Array.isArray(msg.content)) {
        const kept = msg.content.filter((p) => !isTextPart(p));
        msg.content = [{ type: 'text', text }, ...kept];
    }
    else {
        msg.content = text;
    }
}
function firstUserText(req) {
    for (const msg of req.messages) {
        if (msg.role === 'user')
            return contentText(msg.content).slice(0, 4096);
    }
    return '';
}
function responsesContentText(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((p) => typeof p === 'object'
        && p !== null
        && p.type === 'input_text'
        && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n\n');
}
function firstResponsesUserText(inputWasString, originalInput, inputItems) {
    if (inputWasString)
        return (originalInput ?? '').slice(0, 4096);
    for (const item of inputItems) {
        if (item.role !== 'user')
            continue;
        return responsesContentText(item.content).slice(0, 4096);
    }
    return '';
}
function isFunctionTool(tool) {
    return (typeof tool === 'object'
        && tool !== null
        && tool.type === 'function'
        && typeof tool.function === 'object'
        && tool.function !== null);
}
function isFlatFunctionTool(tool) {
    return (typeof tool === 'object'
        && tool !== null
        && tool.type === 'function'
        && typeof tool.name === 'string');
}
/** Render schema annotations removed from the native tool definition. The full
 * top-level description rides in the same image and is replaced by a short
 * per-tool pointer, matching the Anthropic tool-reference approach. */
export function schemaAnnotationLines(node, path = '$', depth = 0) {
    if (!node || typeof node !== 'object' || depth > 20)
        return [];
    if (Array.isArray(node)) {
        return node.flatMap((value, i) => schemaAnnotationLines(value, `${path}[${i}]`, depth + 1));
    }
    const obj = node;
    const out = [];
    for (const key of ['description', 'title', 'examples', 'default', '$comment']) {
        if (obj[key] !== undefined)
            out.push(`${path} ${key}: ${JSON.stringify(obj[key])}`);
    }
    if (typeof obj.format === 'string' && obj.format.length > 32) {
        out.push(`${path} format: ${JSON.stringify(obj.format)}`);
    }
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
        const children = obj[key];
        if (!children || typeof children !== 'object' || Array.isArray(children))
            continue;
        for (const [name, child] of Object.entries(children)) {
            out.push(...schemaAnnotationLines(child, `${path}.${name}`, depth + 1));
        }
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
        const children = obj[key];
        if (!Array.isArray(children))
            continue;
        children.forEach((child, i) => {
            out.push(...schemaAnnotationLines(child, `${path}.${key}[${i}]`, depth + 1));
        });
    }
    for (const key of [
        'items', 'additionalProperties', 'not', 'contains', 'propertyNames',
        'unevaluatedItems', 'unevaluatedProperties', 'if', 'then', 'else',
    ]) {
        if (obj[key] !== undefined) {
            out.push(...schemaAnnotationLines(obj[key], `${path}.${key}`, depth + 1));
        }
    }
    return out;
}
function renderToolDoc(tool) {
    const f = tool.function;
    const annotations = schemaAnnotationLines(f.parameters);
    return f.description || annotations.length
        ? [`## Tool: ${f.name ?? '?'}`, f.description ?? '', ...annotations].filter(Boolean).join('\n')
        : '';
}
function renderFlatToolDoc(tool) {
    const annotations = schemaAnnotationLines(tool.parameters);
    return tool.description || annotations.length
        ? [`## Tool: ${tool.name ?? '?'}`, tool.description ?? '', ...annotations].filter(Boolean).join('\n')
        : '';
}
function rewriteToolsForGpt(tools) {
    if (!Array.isArray(tools) || tools.length === 0)
        return { tools, docs: '' };
    const docs = [];
    let changed = false;
    const rewritten = tools.map((tool) => {
        if (!isFunctionTool(tool))
            return tool;
        const doc = renderToolDoc(tool);
        if (doc)
            docs.push(doc);
        if (tool.function.parameters === undefined)
            return tool;
        changed = true;
        return {
            ...tool,
            function: {
                ...tool.function,
                description: `Full docs: see "## Tool: ${tool.function.name ?? '?'}" in the rendered context image.`,
                parameters: stripSchemaDescriptions(tool.function.parameters),
            },
        };
    });
    return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}
function rewriteFlatToolsForGpt(tools) {
    if (!Array.isArray(tools) || tools.length === 0)
        return { tools, docs: '' };
    const docs = [];
    let changed = false;
    const rewritten = tools.map((tool) => {
        if (!isFlatFunctionTool(tool))
            return tool;
        const doc = renderFlatToolDoc(tool);
        if (doc)
            docs.push(doc);
        if (tool.parameters === undefined)
            return tool;
        changed = true;
        return {
            ...tool,
            description: `Full docs: see "## Tool: ${tool.name ?? '?'}" in the rendered context image.`,
            parameters: stripSchemaDescriptions(tool.parameters),
        };
    });
    return { tools: changed ? rewritten : tools, docs: docs.join('\n\n') };
}
/** Shared by normal outbound requests and profile-aligned evaluations. */
export function openAIImageDetail(model) {
    const isGpt5Family = typeof model === 'string' && /^gpt-5/i.test(model);
    return resolveGptProfile(model).imageDetail ?? (isGpt5Family ? 'original' : 'high');
}
function openAIImagePart(img, model) {
    return {
        type: 'image_url',
        image_url: {
            url: `data:image/png;base64,${bytesToBase64(img.png)}`,
            detail: openAIImageDetail(model),
        },
    };
}
/** Build a Responses API input_image part. */
function responsesImagePart(img, model) {
    return {
        type: 'input_image',
        image_url: `data:image/png;base64,${bytesToBase64(img.png)}`,
        detail: openAIImageDetail(model),
    };
}
function countOutgoingTextChars(req) {
    let n = 0;
    for (const msg of req.messages)
        n += contentText(msg.content).length;
    if (Array.isArray(req.tools)) {
        for (const tool of req.tools) {
            if (!isFunctionTool(tool))
                continue;
            const f = tool.function;
            if (typeof f.name === 'string')
                n += f.name.length;
            if (typeof f.description === 'string')
                n += f.description.length;
            if (f.parameters !== undefined)
                n += safeStringifyLen(f.parameters);
        }
    }
    return n;
}
/** Local o200k decomposition of the original Responses request. This is
 * diagnostic only and never calls Anthropic/provider count_tokens. */
function measureResponsesComposition(req, inputWasString, originalInputString, inputItems) {
    const c = {
        instructions: gptTextTokens(typeof req.instructions === 'string' ? req.instructions : ''),
        systemDeveloper: 0,
        userAssistant: 0,
        functionCalls: 0,
        functionOutputs: 0,
        reasoningEncrypted: 0,
        compactionOpaque: 0,
        toolsJson: Array.isArray(req.tools) ? gptTextTokens(JSON.stringify(req.tools)) : 0,
        other: 0,
        totalLocal: 0,
        imageParts: 0,
    };
    if (inputWasString) {
        c.userAssistant += gptTextTokens(originalInputString ?? '');
    }
    const countImages = (content) => {
        if (!Array.isArray(content))
            return 0;
        return content.filter((p) => {
            const type = p?.type;
            return type === 'input_image' || type === 'image' || type === 'output_image';
        }).length;
    };
    for (const item of inputItems) {
        const o = item;
        const type = typeof o.type === 'string' ? o.type : '';
        const role = typeof o.role === 'string' ? o.role : '';
        c.imageParts += countImages(o.content);
        if (role === 'system' || role === 'developer') {
            c.systemDeveloper += gptTextTokens(responsesContentText(o.content));
        }
        else if (role === 'user' || role === 'assistant') {
            c.userAssistant += gptTextTokens(responsesContentText(o.content));
        }
        else if (isResponsesToolCall(o)) {
            c.functionCalls += gptTextTokens(JSON.stringify(o));
        }
        else if (isResponsesToolOutput(o)) {
            c.functionOutputs += gptTextTokens(typeof o.output === 'string' ? o.output : JSON.stringify(o.output ?? ''));
            c.imageParts += countImages(o.output);
        }
        else if (type === 'reasoning') {
            // Ciphertext length is NOT a provider input-token measurement.
            c.reasoningItems = (c.reasoningItems ?? 0) + 1;
            c.reasoningEncryptedChars = (c.reasoningEncryptedChars ?? 0) + (typeof o.encrypted_content === 'string' ? o.encrypted_content.length : 0);
        }
        else if (type === 'compaction' || type === 'compaction_trigger' ||
            type === 'context_compaction' || type === 'item_reference') {
            c.compactionOpaqueChars = (c.compactionOpaqueChars ?? 0) + (typeof o.encrypted_content === 'string' ? o.encrypted_content.length : 0);
        }
        else if (!role && type) {
            c.other += gptTextTokens(JSON.stringify(o));
        }
    }
    c.totalLocal = c.instructions + c.systemDeveloper + c.userAssistant +
        c.functionCalls + c.functionOutputs + c.reasoningEncrypted +
        c.compactionOpaque + c.toolsJson + c.other;
    return c;
}
function countResponsesOutgoingTextChars(req) {
    let n = 0;
    if (typeof req.instructions === 'string')
        n += req.instructions.length;
    if (typeof req.input === 'string') {
        n += req.input.length;
    }
    else if (Array.isArray(req.input)) {
        for (const item of req.input) {
            n += responsesContentText(item.content).length;
        }
    }
    if (Array.isArray(req.tools)) {
        for (const tool of req.tools) {
            if (!isFlatFunctionTool(tool))
                continue;
            if (typeof tool.name === 'string')
                n += tool.name.length;
            if (typeof tool.description === 'string')
                n += tool.description.length;
            if (tool.parameters !== undefined)
                n += safeStringifyLen(tool.parameters);
        }
    }
    return n;
}
function safeStringifyLen(v) {
    try {
        return JSON.stringify(v)?.length ?? 0;
    }
    catch {
        return 0;
    }
}
export function droppedCodepointsTop(droppedCodepoints) {
    if (droppedCodepoints.size === 0)
        return undefined;
    const out = {};
    for (const [cp, count] of [...droppedCodepoints.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)) {
        out[`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`] = count;
    }
    return out;
}
/** Shared gate: image vs text token cost → profitability.
 *
 *  Profiles with a local-token floor always use o200k (same baseline as savings
 *  math). Legacy non-o200k profiles retain the charsPerToken override. Images bill full
 *  pages at maxHeight and the last page at residual height — charging every page
 *  as a full strip over-states cost and blocks profitable collapses. */
function evalOpenAIGate(model, renderedText, cols, charsPerToken, baselineTextTokens) {
    const profile = resolveGptProfile(model);
    const style = profile.style;
    const cellW = renderCellWidth(style);
    const cellH = renderCellHeight(style);
    const stripW = 2 * PAD_X + cols * cellW;
    const canvasRows = Math.max(1, Math.floor((profile.maxHeightPx - 2 * PAD_Y) / cellH));
    const fullPageHeight = 2 * PAD_Y + canvasRows * cellH;
    const maxLines = canvasRows;
    const maxCharsPerImage = Math.min(READABLE_CHARS_PER_IMAGE, Math.max(1, cols) * maxLines);
    const linesPerImage = Math.min(maxLines, Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols))));
    const estImages = estimateImageCount(renderedText, cols, maxCharsPerImage, maxLines);
    // Last page: residual soft-wrapped rows, not a full strip.
    const visualRows = countVisualRows(renderedText, cols);
    const lastPageLines = estImages <= 1
        ? Math.min(linesPerImage, Math.max(1, visualRows))
        : Math.min(linesPerImage, Math.max(1, visualRows - (estImages - 1) * linesPerImage));
    const lastPageHeight = Math.min(profile.maxHeightPx, 2 * PAD_Y + lastPageLines * cellH);
    const fullPageTokens = visionTokens(profile, stripW, fullPageHeight);
    const lastPageTokens = visionTokens(profile, stripW, lastPageHeight);
    // No GATE_MARGIN here, unlike the Anthropic slab/history gate, and that
    // asymmetry is deliberate rather than drift:
    //   - this path reproduces the renderer's own page split from the SAME
    //     profile geometry, so `imageTokens` is the exact cost of the images that
    //     will be sent (tests pin gateEval.imageTokens === info.imageTokens);
    //   - it compares against an exact o200k count of the text baseline, not a
    //     chars-per-token approximation.
    // Both sides are exact, so a margin would only be pessimism: it would refuse
    // real, measured savings. The Anthropic gate estimates rows/pages heuristically,
    // which is the estimation error GATE_MARGIN exists to absorb.
    const imageTokens = estImages <= 1
        ? lastPageTokens
        : (estImages - 1) * fullPageTokens + lastPageTokens;
    const textTokens = baselineTextTokens ?? (profile.minCompressTokens !== undefined || charsPerToken === DEFAULTS.charsPerToken
        ? Math.max(1, gptTextTokens(renderedText) || Math.ceil(renderedText.length / charsPerToken))
        : renderedText.length / Math.max(1e-6, charsPerToken));
    return { imageTokens, textTokens, profitable: imageTokens < textTokens };
}
function usesExactStaticBaseline(model) {
    return resolveGptProfile(model).exactStaticBaseline === true;
}
/** Shared image-part accumulation from rendered PNGs. */
function accumulateRenderedImages(images, info) {
    const droppedCodepoints = new Map();
    for (const img of images) {
        info.imageBytes += img.png.length;
        info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
        info.droppedChars = (info.droppedChars ?? 0) + img.droppedChars;
        for (const [cp, count] of img.droppedCodepoints) {
            droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
        }
    }
    return { droppedCodepoints };
}
/** o200k_base token count — gpt-5 / gpt-4o / o-series share this encoding. The
 *  honest "as plain text" baseline for the content pxpipe imaged. Pure JS, no
 *  native build, runs in both Node and Workers. */
function gptTextTokens(text) {
    if (!text)
        return 0;
    try {
        return o200kCountTokens(text);
    }
    catch {
        return 0;
    }
}
/** Local estimate, not a model-specific official tokenizer. Opaque state is
 * deliberately excluded; the host calibrates a shared offset from real usage. */
export function estimateResponsesCacheTokens(req) {
    let tokens = 0, opaqueItems = 0, unknownImages = 0, textFallbacks = 0, visibleTextChars = 0;
    const text = value => {
        if (typeof value !== 'string' || !value) return;
        visibleTextChars += value.length;
        try { tokens += o200kCountTokens(value); }
        catch { tokens += Math.ceil(value.length / 3); textFallbacks++; }
    };
    const image = part => {
        const url = typeof part.image_url === 'string' ? part.image_url
            : part.image_url?.url ?? part.source?.data ?? '';
        let w = 1024, h = 1024, known = false;
        if (typeof url === 'string' && url.startsWith('data:image/png;base64,')) {
            try {
                const bytes = atob(url.slice(22, 66));
                if (bytes.startsWith('\x89PNG\r\n\x1a\n') && bytes.length >= 24) {
                    const u32 = i => ((bytes.charCodeAt(i) * 16777216) + (bytes.charCodeAt(i + 1) << 16)
                        + (bytes.charCodeAt(i + 2) << 8) + bytes.charCodeAt(i + 3));
                    const width = u32(16), height = u32(20);
                    if (width > 0 && height > 0 && width <= 100000 && height <= 100000) {
                        w = width; h = height; known = true;
                    }
                }
            }
            catch { /* Remote/non-PNG/invalid images use an explicitly marked estimate. */ }
        }
        if (!known) unknownImages++;
        tokens += visionTokens(resolveGptProfile(req.model), w, h);
    };
    const parts = content => {
        if (typeof content === 'string') { text(content); return; }
        if (!Array.isArray(content)) return;
        for (const part of content) {
            if (!part || typeof part !== 'object') continue;
            if (['input_image', 'image_url', 'image'].includes(part.type)) image(part);
            else if (typeof part.text === 'string') text(part.text);
        }
    };
    text(req.instructions);
    if (Array.isArray(req.tools)) text(JSON.stringify(req.tools));
    if (typeof req.input === 'string') text(req.input);
    else if (Array.isArray(req.input)) for (const item of req.input) {
        if (!item || typeof item !== 'object') continue;
        // Never claim a saving from deleting opaque state, including guessed
        // framing overhead. Its unmeasured usage offset is shared by both plans.
        if (item.type === 'reasoning') { opaqueItems++; continue; }
        tokens += 12;
        if (isResponsesToolCall(item)) {
            text(item.name); text(item.arguments); text(item.input);
        }
        else if (isResponsesToolOutput(item)) parts(item.output ?? item.content);
        else parts(item.content);
    }
    return { tokens, opaqueItems, unknownImages, textFallbacks, visibleTextChars };
}
/** Vision-token cost of the rendered images, summed over their real dims —
 *  what GPT actually bills as input for the slab pxpipe imaged. */
function gptImageTokens(model, images) {
    let n = 0;
    for (const img of images)
        n += visionTokensForModel(model, img.width, img.height);
    return n;
}
/** Text-token value of what pxpipe replaced with images this request: the
 *  original system/developer text (now a pointer + image) plus the tool
 *  *description* tokens stripped from the native JSON (the verbose docs moved
 *  into the image). Tool *structure* stays in the JSON on both paths, so only
 *  the stripped delta counts. Compared against gptImageTokens for the saving. */
function gptBaselineImagedTokens(systemTexts, originalTools, strippedTools) {
    let n = 0;
    for (const t of systemTexts)
        n += gptTextTokens(t);
    const orig = Array.isArray(originalTools) && originalTools.length > 0
        ? gptTextTokens(JSON.stringify(originalTools))
        : 0;
    const stripped = Array.isArray(strippedTools) && strippedTools.length > 0
        ? gptTextTokens(JSON.stringify(strippedTools))
        : 0;
    return n + Math.max(0, orig - stripped);
}
/** Fold a history-collapse plan into TransformInfo: the history images cost
 *  vision tokens (added to imageTokens) and stand in for the o200k text tokens
 *  the collapsed transcript would have cost unproxied (added to baselineImagedTokens).
 *  openai-savings.ts then credits (baseline − image) × cache-weight with no
 *  further change. Also merges image bytes/pixels/dropped + collapse telemetry. */
function foldGptHistory(info, model, plan) {
    // A pin can split the collapse into before/after image groups — account for both.
    const allImages = [...plan.images, ...plan.imagesAfter];
    if (allImages.length === 0) {
        if (plan.reason)
            info.historyReason = plan.reason;
        if (plan.collapsedChars > 0)
            info.historyTextChars = plan.collapsedChars;
        return;
    }
    info.imageTokens = (info.imageTokens ?? 0) + gptImageTokens(model, allImages);
    // o200k token value of the collapsed transcript (what it cost as plain text).
    info.baselineImagedTokens = (info.baselineImagedTokens ?? 0) +
        (plan.baselineTokens ?? gptTextTokens(plan.text));
    info.imageCount = (info.imageCount ?? 0) + allImages.length;
    for (const img of allImages) {
        info.imageBytes = (info.imageBytes ?? 0) + img.png.length;
        info.imagePixels = (info.imagePixels ?? 0) + img.width * img.height;
    }
    info.imagePngs = [...(info.imagePngs ?? []), ...allImages.map((i) => i.png)];
    info.imageDims = [
        ...(info.imageDims ?? []),
        ...allImages.map((i) => ({ width: i.width, height: i.height })),
    ];
    info.imageSourceTexts = [
        ...(info.imageSourceTexts ?? []),
        ...plan.imageSources,
        ...plan.imageSourcesAfter,
    ];
    if (plan.droppedChars > 0)
        info.droppedChars = (info.droppedChars ?? 0) + plan.droppedChars;
    info.collapsedTurns = plan.collapsedTurns;
    info.collapsedChars = plan.collapsedChars;
    info.collapsedImages = allImages.length;
    info.historyTextChars = plan.collapsedChars;
    info.historyReason = 'collapsed';
    info.bucketChars = { ...(info.bucketChars ?? {}), history: plan.collapsedChars };
}
async function applyChatHistoryCollapse(req, info, o, profile, protectedPrefix) {
    const profitable = (text, cols, baselineTextTokens) => evalOpenAIGate(req.model, text, cols, o.charsPerToken, baselineTextTokens).profitable;
    // Chat collapses a contiguous prefix: protect rendered recall/system images,
    // then permit ordinary old client screenshots to become history markers.
    for (let i = protectedPrefix; i < req.messages.length; i++)
        if (isRenderedGptContext(req.messages[i]))
            protectedPrefix = i + 1;
    // Count images already in the request. At the main call site the static slab
    // images are inserted into req.messages before this runs, so walking the
    // messages (instead of also adding info.imageCount) avoids double-counting
    // the slab and matches the Responses path's budget math.
    const existingImages = countRequestImages(req.messages);
    const plan = await planGptCollapse(chatMessagesToTurns(req.messages, { dropTools: true, collapseImages: true }), protectedPrefix, profitable, gptHistoryOpts(req.model, o, profile, existingImages, pxliteGptForced(req.messages, existingImages), req.messages));
    foldGptHistory(info, req.model, plan);
    const allImages = [...plan.images, ...plan.imagesAfter];
    if (allImages.length === 0)
        return false;
    const compactFraming = profile.history.framing === 'compact';
    const intro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
    const outro = compactFraming ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
    // A growing single message changes its old endpoint and moves a global
    // fact-sheet. Emit each frozen source as its own stable native message.
    const history = [];
    let injected = '';
    const appendGroups = (images, sources) => {
        for (let i = 0; i < images.length;) {
            const source = sources[i] ?? '';
            const content = [{ type: 'text', text: intro }];
            do {
                content.push(openAIImagePart(images[i++], req.model));
            } while (i < images.length && sources[i] === source);
            const sheet = factSheetText(source, profile.factSheetFormat);
            if (sheet)
                content.push({ type: 'text', text: sheet });
            content.push({ type: 'text', text: outro });
            injected += intro + sheet + outro;
            history.push({ role: 'user', content });
        }
    };
    appendGroups(plan.images, plan.imageSources);
    if (plan.pinText !== undefined) {
        history.push({ role: 'user', content: [{ type: 'text', text: pinnedRequestBlock(plan.pinText) }] });
        appendGroups(plan.imagesAfter, plan.imageSourcesAfter);
    }
    const guard = buildLiveRequestGuard(plan.pinText);
    req.messages = [
        ...req.messages.slice(0, plan.start),
        ...history,
        { role: 'developer', content: guard },
        ...req.messages.slice(plan.endExclusive),
    ];
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0)
        + gptTextTokens(injected + guard);
    info.historyImageSha = await sha8(allImages.map((i) => bytesToBase64(i.png)).join(''));
    return true;
}
async function applyResponsesSummaryHistory(req, source, info, o, profile, slab) {
    const gate = o.gptHistory?.cacheGate;
    const renderHistorySheet = createHistoryFactSheetRenderer(profile).render;
    const nativeImages = source.reduce((n, item) => n + [item.content, item.output]
        .reduce((m, parts) => m + (Array.isArray(parts) ? parts.filter(p =>
            p && ['input_image', 'image_url', 'image'].includes(p.type)).length : 0), 0), 0);
    const current = gptHistoryOpts(req.model, o, profile,
        (info.imageCount ?? 0) + nativeImages, false, source);
    const historyOpts = { ...current, ...gate?.heldOptions,
        reasoningMode: 'summary', checkpointBootstrap: false,
        checkpointChunk: current.checkpointChunk,
        // Projector upgrades are economic candidates, never silent changes to
        // an already committed prefix. Missing persisted version means v1.
        projectionVersion: current.projectionVersion ?? 5,
        keepTail: Math.max(30, current.keepTail, gate?.heldOptions?.keepTail ?? 0),
        maxImages: Math.min(current.maxImages, gate?.heldOptions?.maxImages ?? current.maxImages) };
    const chunk = Math.floor(historyOpts.checkpointChunk ?? 130);
    if (!Number.isFinite(chunk) || chunk <= 1) return false;
    const available = Math.max(0, source.length - historyOpts.keepTail);
    // Anchor upgrades to the last committed cutoff, not a new global grid:
    // 1900 -> 2030, never 1900 -> 1950 after switching 50 to 130.
    const anchor = Math.min(available, gate?.heldCutoff ?? 0);
    const candidateCutoff = anchor + Math.floor((available - anchor) / chunk) * chunk;
    if (candidateCutoff === gate?.heldCutoff && gate?.heldOptions?.checkpointChunk !== undefined)
        historyOpts.checkpointChunk = gate.heldOptions.checkpointChunk;
    const frame = (cutoff, options = historyOpts) => ({ ...options, checkpointCutoff: cutoff });
    const profitable = (text, cols, baseline) =>
        evalOpenAIGate(req.model, text, cols, o.charsPerToken, baseline).profitable;
    const planAt = (cutoff, options) => planResponsesSummaryCollapse(source, profitable, frame(cutoff, options));
    let plan = await planAt(candidateCutoff);
    const failSafe = reason => {
        info.historyReason = reason;
        info.gptCacheGate = { history_mode: 'summary', accept: false, reason,
            wire_applied: false, chosen_cutoff: gate?.heldCutoff ?? 0,
            candidate_cutoff: candidateCutoff, source_items: source.length };
        return false;
    };
    const unsafePlan = p => ['summary_image_budget', 'summary_native_reference'].includes(p.reason);
    if (unsafePlan(plan)) return failSafe(plan.reason);
    const materialize = p => {
        const replacements = new Map(), removed = new Set(p.selectedIndices);
        const compact = profile.history.framing === 'compact';
        const intro = compact ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
        const outro = compact ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
        let injectedTokens = 0;
        // Fact sheets are local to immutable pages, not a request-wide mutable sheet.
        for (const segment of p.segments) {
            if (!segment.images.length && !segment.text.trim()) continue;
            const sheet = renderHistorySheet(segment.text);
            const content = [{ type: 'input_text', text: intro },
                ...segment.images.map(img => responsesImagePart(img, req.model)),
                ...(sheet ? [{ type: 'input_text', text: sheet }] : []),
                { type: 'input_text', text: outro, ...responsesCacheBreakpoint(req, profile) }];
            const at = replacements.get(segment.insertAt) ?? [];
            at.push({ role: 'user', content });
            replacements.set(segment.insertAt, at);
            injectedTokens += gptTextTokens(intro + sheet + outro);
        }
        const input = [], positions = [];
        for (let i = 0; i < source.length; i++) {
            positions[i] = input.length;
            if (slab?.at === i) input.push(slab.item);
            if (replacements.has(i)) input.push(...replacements.get(i));
            if (!removed.has(i)) input.push(source[i]);
        }
        positions[source.length] = input.length;
        // Autonomous tool loops still need the current user task as native text.
        // This guard is a live suffix; it never edits a previously sealed page.
        let latestUser = -1;
        for (let i = 0; i < source.length; i++) if (source[i].role === 'user'
            && !isRenderedGptContext(source[i])) latestUser = i;
        if (removed.has(latestUser)) {
            const text = responsesContentText(source[latestUser].content);
            if (text) {
                const guard = buildLiveRequestGuard(text);
                input.push({ role: 'user', content: [{ type: 'input_text', text: guard }] });
                injectedTokens += gptTextTokens(guard);
            }
        }
        return { input, injectedTokens, positions };
    };
    let selected = materialize(plan);
    const heldCutoff = Math.min(candidateCutoff, gate?.heldCutoff ?? 0);
    const heldProjectionVersion = gate?.heldOptions?.projectionVersion ?? 1;
    const heldPlan = heldCutoff === candidateCutoff && heldProjectionVersion === historyOpts.projectionVersion
        && (gate?.heldOptions?.checkpointChunk ?? chunk) === chunk
        ? plan : await planAt(heldCutoff, { ...historyOpts, ...gate?.heldOptions, projectionVersion: heldProjectionVersion });
    if (unsafePlan(heldPlan)) return failSafe(heldPlan.reason);
    const held = heldPlan === plan ? selected : materialize(heldPlan);
    const candidateEstimate = estimateResponsesCacheTokens({ ...req, input: selected.input });
    const heldEstimate = held === selected ? candidateEstimate
        : estimateResponsesCacheTokens({ ...req, input: held.input });
    const oldClosedThrough = Math.min(source.length,
        gate?.heldClosedThrough ?? heldPlan.summaryState?.closedThrough ?? 0);
    const replaySignature = await sha8(JSON.stringify(held.input.slice(0, held.positions[oldClosedThrough] ?? 0)));
    const historyReset = !!gate?.heldSignature && gate.heldSignature !== replaySignature;
    const candidatePrefixSignature = await sha8(JSON.stringify(
        selected.input.slice(0, selected.positions[oldClosedThrough] ?? 0)));
    const sealedPrefixPreserved = !historyReset && (gate?.heldSignature
        ? gate.heldSignature === candidatePrefixSignature
        : oldClosedThrough === 0);
    let common = 0;
    while (common < Math.min(held.input.length, selected.input.length)
        && JSON.stringify(held.input[common]) === JSON.stringify(selected.input[common])) common++;
    const preserved = historyReset ? 0
        : estimateResponsesCacheTokens({ ...req, input: held.input.slice(0, common) }).tokens;
    const newlyRemoved = Math.max(0, (plan.summaryState?.removed ?? 0) - (heldPlan.summaryState?.removed ?? 0));
    const candidateDiagnostics = {
        candidate_archived_pairs: plan.pairState?.collapsedPairs ?? 0,
        candidate_native_pair_reasons: plan.summaryState?.nativeToolPairReasons ?? {},
        candidate_history_images: plan.images.length,
    };
    const decision = gate?.evaluate ? gate.evaluate({
        candidateCutoff, baselineTokens: heldEstimate.tokens, candidateTokens: candidateEstimate.tokens,
        preservedPrefixTokens: preserved, reasoningRemoved: newlyRemoved, summaryMode: true,
        savedTextChars: Math.max(0, heldEstimate.visibleTextChars - candidateEstimate.visibleTextChars),
        baselineOpaqueItems: heldEstimate.opaqueItems, candidateOpaqueItems: candidateEstimate.opaqueItems,
        sealedPrefixPreserved,
        sameWire: JSON.stringify(held.input) === JSON.stringify(selected.input),
        opaquePrefixChanged: newlyRemoved > 0, options: historyOpts, profile,
    }) : { accept: true, chosen_cutoff: candidateCutoff, history_mode: 'summary' };
    if (!decision.accept) { plan = heldPlan; selected = held; }
    const estimate = decision.accept ? candidateEstimate : heldEstimate;
    const closedThrough = plan.summaryState?.closedThrough ?? 0;
    const closedSignature = await sha8(JSON.stringify(selected.input.slice(0, selected.positions[closedThrough] ?? 0)));
    info.gptCacheGate = { ...decision, history_mode: 'summary', wire_applied: true,
        ...(historyReset ? { history_reset: true, economic_reason: decision.reason,
            reason: 'archive_source_or_dependency_changed' } : {}),
        closed_prefix_signature: closedSignature,
        candidate_cutoff: candidateCutoff, source_items: source.length,
        native_tail_floor: historyOpts.keepTail,
        closed_through: closedThrough,
        reasoning_removed: plan.summaryState?.removed ?? 0,
        reasoning_summaries: plan.summaryState?.summaries ?? 0,
        reasoning_protected: plan.summaryState?.protected ?? 0,
        candidate_reasoning_removed: newlyRemoved,
        ...candidateDiagnostics,
        deferred_epochs: decision.accept ? 0 : Math.max(0, Math.floor((candidateCutoff - heldCutoff) / chunk)),
        opaque_items: estimate.opaqueItems, unknown_image_dimensions: estimate.unknownImages,
        text_fallbacks: estimate.textFallbacks };
    const ps = plan.pairState;
    if (ps && info.responsesComposition) {
        const rc = info.responsesComposition;
        Object.assign(rc, { completedFunctionPairs: ps.completedPairs,
            recentNativeFunctionPairs: ps.recentCompletedPairs, oldFunctionPairs: ps.oldCompletedPairs,
            openFunctionCalls: ps.openCalls, orphanFunctionOutputs: ps.orphanOutputs,
            malformedFunctionItems: ps.malformedItems, collapsedFunctionPairs: ps.collapsedPairs,
            collapsedFunctionCalls: ps.collapsedFunctionCallTokens,
            collapsedFunctionOutputs: ps.collapsedFunctionOutputTokens,
            nativeFunctionPairReasons: plan.summaryState?.nativeToolPairReasons ?? {} });
    }
    foldGptHistory(info, req.model, plan);
    if (!plan.images.length && plan.selectedIndices.length) {
        info.historyReason = 'summary_checkpoint_no_images';
        info.collapsedTurns = plan.selectedIndices.length;
    }
    req.input = selected.input;
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0) + selected.injectedTokens;
    if (plan.images.length) info.historyImageSha = await sha8(plan.images.map(img => bytesToBase64(img.png)).join(''));
    return plan.selectedIndices.length > 0;
}
async function applyResponsesHistoryCollapse(req, inputItems, info, o, profile, summarySource) {
    if (o.gptHistory?.reasoningMode === 'summary')
        return applyResponsesSummaryHistory(req, summarySource?.items ?? inputItems, info, o, profile, summarySource?.slab);
    const historySheets = createHistoryFactSheetRenderer(profile);
    const renderHistorySheet = historySheets.render;
    // Match emission's prefix-local deduplication. Only accepted sections cover
    // spellings; rejected sections must not make a later replacement look cheaper.
    const plannedSheetTokens = profile.history.factSheetOverflow === 'native-opaque'
        ? new Set() : undefined;
    const profitable = (text, cols, baselineTextTokens, sourceText = text) => {
        const gate = evalOpenAIGate(req.model, text, cols, o.charsPerToken, baselineTextTokens);
        if (!gate.profitable)
            return false;
        const maxReads = profile.history.maxCachePaybackReads;
        const framing = profile.history.framing === 'compact'
            ? COMPACT_HISTORY_TRANSCRIPT_INTRO + COMPACT_HISTORY_TRANSCRIPT_OUTRO
            : HISTORY_TRANSCRIPT_INTRO + HISTORY_TRANSCRIPT_OUTRO;
        const sheet = renderHistorySheet(sourceText, plannedSheetTokens);
        const collapsedTokens = gate.imageTokens + gptTextTokens(sheet + framing);
        if (collapsedTokens >= gate.textTokens)
            return false;
        const accepted = maxReads === undefined
            || computeOpenAICollapsePaybackReads(gate.textTokens, collapsedTokens, req.model) <= maxReads;
        if (accepted && plannedSheetTokens) {
            for (const token of extractFactSheetTokens(sheet))
                plannedSheetTokens.add(token);
        }
        return accepted;
    };
    const existingImages = info.imageCount ?? 0;
    const gate = o.gptHistory?.cacheGate;
    const currentOpts = gptHistoryOpts(req.model, o, profile, existingImages, pxliteGptForced(inputItems, existingImages), inputItems);
    // Freeze planning floors and reader geometry, not merely the numeric cutoff.
    // A larger live tail must not image previously native history in the same epoch.
    const historyOpts = { ...currentOpts, ...gate?.heldOptions,
        maxImages: Math.min(currentOpts.maxImages, gate?.heldOptions?.maxImages ?? currentOpts.maxImages) };
    const candidateFrame = checkpointWindow(inputItems.length, historyOpts);
    const planAt = async opts => {
        plannedSheetTokens?.clear();
        return planResponsesPairCollapse(inputItems, profitable, opts);
    };
    let plan = await planAt(historyOpts);
    const materialize = (selectedPlan, frame) => {
        historySheets.beginEmission();
        const replacements = new Map();
        const compact = profile.history.framing === 'compact';
        const intro = compact ? COMPACT_HISTORY_TRANSCRIPT_INTRO : HISTORY_TRANSCRIPT_INTRO;
        const outro = compact ? COMPACT_HISTORY_TRANSCRIPT_OUTRO : HISTORY_TRANSCRIPT_OUTRO;
        const covered = profile.history.factSheetOverflow === 'native-opaque' ? new Set() : undefined;
        let injectedTokens = 0;
        for (const segment of selectedPlan.segments) {
            const content = [{ type: 'input_text', text: intro },
                ...segment.images.map(img => responsesImagePart(img, req.model))];
            const sheet = renderHistorySheet(segment.text, covered);
            if (sheet) {
                content.push({ type: 'input_text', text: sheet });
                if (covered) for (const token of extractFactSheetTokens(sheet)) covered.add(token);
            }
            content.push({ type: 'input_text', text: outro, ...responsesCacheBreakpoint(req, profile) });
            injectedTokens += gptTextTokens(intro + sheet + outro);
            replacements.set(segment.insertAt, { role: 'user', content });
        }
        const pruning = gate && Number.isFinite(o.gptHistory?.reasoningKeep)
            ? responsesReasoningPrune(inputItems, frame, o.gptHistory.reasoningKeep)
            : { removed: [], kept: 0, protected: 0 };
        const removed = new Set([...selectedPlan.selectedIndices, ...pruning.removed]);
        const input = [];
        for (let i = 0; i < inputItems.length; i++) {
            const replacement = replacements.get(i);
            if (replacement) input.push(replacement);
            if (!removed.has(i)) input.push(inputItems[i]);
        }
        return { input, injectedTokens, pruning };
    };
    let selected = materialize(plan, candidateFrame);
    if (gate?.evaluate && candidateFrame.managed) {
        const heldOpts = { ...historyOpts, checkpointCutoff: gate.heldCutoff ?? 0 };
        const heldFrame = checkpointWindow(inputItems.length, heldOpts);
        const heldPlan = heldFrame.cutoff === candidateFrame.cutoff ? plan : await planAt(heldOpts);
        const held = heldPlan === plan ? selected : materialize(heldPlan, heldFrame);
        const candidateEstimate = estimateResponsesCacheTokens({ ...req, input: selected.input });
        const heldEstimate = held === selected ? candidateEstimate
            : estimateResponsesCacheTokens({ ...req, input: held.input });
        const decision = gate.evaluate({
            candidateCutoff: candidateFrame.cutoff,
            baselineTokens: heldEstimate.tokens,
            candidateTokens: candidateEstimate.tokens,
            savedTextChars: Math.max(0, heldEstimate.visibleTextChars - candidateEstimate.visibleTextChars),
            sameWire: JSON.stringify(held.input) === JSON.stringify(selected.input),
            opaquePrefixChanged: selected.pruning.removed.length > held.pruning.removed.length,
            options: historyOpts,
            profile,
        });
        if (!decision.accept) { plan = heldPlan; selected = held; }
        const estimate = decision.accept ? candidateEstimate : heldEstimate;
        info.gptCacheGate = { ...decision,
            candidate_reasoning_removed: candidateFrame.cutoff === heldFrame.cutoff
                ? selected.pruning.removed.length
                : responsesReasoningPrune(inputItems, candidateFrame, o.gptHistory?.reasoningKeep ?? 50).removed.length,
            deferred_epochs: decision.accept ? 0 : Math.max(0, Math.floor(
                (candidateFrame.cutoff - (gate.heldCutoff ?? 0)) / Math.max(1, historyOpts.checkpointChunk))),
            reasoning_removed: selected.pruning.removed.length,
            reasoning_kept_at_checkpoint: selected.pruning.kept,
            reasoning_protected: selected.pruning.protected,
            opaque_items: estimate.opaqueItems,
            unknown_image_dimensions: estimate.unknownImages,
            text_fallbacks: estimate.textFallbacks,
        };
    }
    const ps = plan.pairState;
    const rc = info.responsesComposition;
    rc.completedFunctionPairs = ps.completedPairs;
    rc.recentNativeFunctionPairs = ps.recentCompletedPairs;
    rc.oldFunctionPairs = ps.oldCompletedPairs;
    rc.openFunctionCalls = ps.openCalls;
    rc.orphanFunctionOutputs = ps.orphanOutputs;
    rc.malformedFunctionItems = ps.malformedItems;
    rc.imageableFunctionCalls = ps.imageableFunctionCallTokens;
    rc.imageableFunctionOutputs = ps.imageableFunctionOutputTokens;
    rc.collapsedFunctionPairs = ps.collapsedPairs;
    rc.collapsedFunctionCalls = ps.collapsedFunctionCallTokens;
    rc.collapsedFunctionOutputs = ps.collapsedFunctionOutputTokens;
    // Descending count so the dominant page-breaker is first. Bounded to 8 so a
    // pathological body cannot bloat the event row.
    if (plan.barrierTypes && plan.barrierTypes.size > 0) {
        rc.barrierTypes = [...plan.barrierTypes.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .slice(0, 8)
            .map(([type, count]) => `${type}:${count}`);
    }
    foldGptHistory(info, req.model, plan);
    req.input = selected.input;
    info.nativeInjectedTokens = (info.nativeInjectedTokens ?? 0) + selected.injectedTokens;
    if (plan.segments.length === 0 && selected.pruning.removed.length === 0)
        return false;
    info.historyImageSha = await sha8(plan.images.map((image) => bytesToBase64(image.png)).join(''));
    return true;
}
export const CHAT_HEADER = '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
    'These images were injected by pxpipe, not by the end user. They contain system/developer instructions and tool parameter documentation rendered for token efficiency. Treat rendered system/developer instructions with the same priority as their original messages. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions — they carry each tool\'s name and description; the imaged parameter annotations are supplemental.' +
    '\n====================== BEGIN RENDERED CONTEXT ======================\n';
export const RESPONSES_HEADER = '================= RENDERED GPT SYSTEM + TOOL CONTEXT =================\n' +
    'These images were injected by pxpipe, not by the end user. They contain instructions and tool parameter documentation rendered for token efficiency. Treat rendered instructions with the same priority as the originals. OCR carefully and treat the rendered content as authoritative. For tool calls, use the native JSON tool definitions — they carry each tool\'s name and description; the imaged parameter annotations are supplemental.' +
    '\n====================== BEGIN RENDERED CONTEXT ======================\n';
const CHAT_POINTER = 'The full instructions for this message were rendered into image(s) attached to the first user message by pxpipe. Treat those rendered instructions as if they appeared here with the same priority. Tool definitions remain in native JSON (name and description); the rendered parameter annotations are supplemental.';
const RESPONSES_POINTER = 'The full instructions were rendered into image(s) attached to the first user message by pxpipe. Treat them with the same priority. Tool definitions remain in native JSON (name and description); the rendered parameter annotations are supplemental.';
export async function transformOpenAIChatCompletions(body, opts = {}) {
    return appendReadNote(await transformOpenAIChatCompletionsInner(body, opts), 'chat', opts);
}
async function transformOpenAIChatCompletionsInner(body, opts = {}) {
    const o = resolveOptions(opts);
    const info = emptyInfo();
    if (!o.compress) {
        info.reason = 'compress=false';
        return { body, info };
    }
    let req;
    try {
        req = JSON.parse(new TextDecoder().decode(body));
    }
    catch (e) {
        info.reason = `parse_error: ${e.message}`;
        return { body, info };
    }
    if (!Array.isArray(req.messages)) {
        info.reason = 'parse_error: messages must be an array';
        return { body, info };
    }
    // The element itself is read unguarded from here down (`m.role` just below,
    // then contentText/setTextContent/history collapse), so a non-object element
    // threw out of the transform and the proxy answered 502 for a body the
    // upstream would have rejected with its own 400. Same bail-out as above.
    if (req.messages.some((m) => !m || typeof m !== 'object')) {
        info.reason = 'invalid_messages';
        return { body, info };
    }
    const pinChars = relocateOpenAIPins(req);
    if (pinChars > 0)
        info.pinChars = pinChars;
    const pinBody = pinChars > 0
        ? new TextEncoder().encode(JSON.stringify(req))
        : body;
    const firstUserIdx = req.messages.findIndex((m) => m.role === 'user');
    if (firstUserIdx < 0) {
        info.reason = 'no_user_message';
        return { body: pinBody, info };
    }
    const authorityDocs = [];
    const systemTexts = [];
    // A non-authority item before the first user is an ordering barrier.
    const openingMessages = req.messages.slice(0, firstUserIdx);
    const staticMessages = openingMessages.every((m) =>
        (m.role === 'system' || m.role === 'developer') &&
        (typeof m.content === 'string' || (Array.isArray(m.content) &&
            m.content.every((p) => isTextPart(p) && Object.keys(p).every((k) => k === 'type' || k === 'text')))))
        ? openingMessages
        : [];
    // Keep later authority at its original conversation position.
    for (const msg of staticMessages) {
        if (msg.role !== 'system' && msg.role !== 'developer')
            continue;
        const text = contentText(msg.content);
        if (!text)
            continue;
        authorityDocs.push(`## ${String(msg.role).toUpperCase()} MESSAGE\n${text}`);
        systemTexts.push(text);
        info.staticChars += text.length;
    }
    const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
        ? rewriteToolsForGpt(req.tools)
        : { tools: req.tools, docs: '' };
    const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
    info.origChars = combinedRaw.length;
    const profile = resolveGptProfile(req.model);
    const finishHistoryOnly = async (reason) => {
        info.reason = reason;
        if (o.collapseHistory && await applyChatHistoryCollapse(req, info, o, profile, firstUserIdx)) {
            info.reason = undefined;
            info.outgoingTextChars = countOutgoingTextChars(req);
            info.compressed = true;
            return { body: new TextEncoder().encode(JSON.stringify(req)), info };
        }
        return { body: pinBody, info };
    };
    if (!combinedRaw) {
        return finishHistoryOnly('no_static_context');
    }
    const firstUser = firstUserText(req);
    if (firstUser)
        info.firstUserSha8 = await sha8(firstUser);
    const combined = compactSlabWhitespace(combinedRaw).trimEnd();
    const minCompressTokens = profile.minCompressTokens;
    const combinedTokens = minCompressTokens === undefined ? undefined : gptTextTokens(combined);
    if (minCompressTokens !== undefined && combinedTokens < minCompressTokens) {
        return finishHistoryOnly(`below_min_tokens (${combinedTokens} < ${minCompressTokens})`);
    }
    if (minCompressTokens === undefined && combined.length < o.minCompressChars) {
        return finishHistoryOnly(`below_min_chars (${combined.length} < ${o.minCompressChars})`);
    }
    const reflowNote = o.reflow
        ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
        : '';
    const header = CHAT_HEADER.replace('\n====', reflowNote + '\n====');
    const renderedText = prepareImagedRenderText(header + combined, o.reflow);
    const maxCols = o.cols ?? profile.stripCols;
    const cols = Math.min(shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font), profile.stripCols);
    const staticBaselineTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
    const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken, opts.charsPerToken === undefined && usesExactStaticBaseline(req.model)
        ? staticBaselineTokens
        : undefined);
    info.gateEval = {
        site: 'slab',
        imageTokens: gate.imageTokens,
        textTokens: gate.textTokens,
        burnImageSide: 0,
        burnTextSide: 0,
        profitable: gate.profitable,
    };
    if (!gate.profitable) {
        info.passthroughReasons = { not_profitable: 1 };
        return finishHistoryOnly(`not_profitable (slab=${combined.length} chars)`);
    }
    const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    if (images.length === 0) {
        info.reason = 'render_empty';
        return { body: pinBody, info };
    }
    // A hard provider cap makes static-first allocation pathological on long Qwen
    // chats: the repeated system slab consumes slots that could replace much more
    // history. Plan against the full cap first and keep static text native when the
    // two image sets cannot coexist.
    if (o.collapseHistory && profile.providerImageCap !== undefined) {
        const historyReq = structuredClone(req);
        const historyInfo = structuredClone(info);
        if (await applyChatHistoryCollapse(historyReq, historyInfo, o, profile, firstUserIdx) && countRequestImages(historyReq.messages) + images.length > profile.providerImageCap) {
            historyInfo.outgoingTextChars = countOutgoingTextChars(historyReq);
            historyInfo.compressed = true;
            return { body: new TextEncoder().encode(JSON.stringify(historyReq)), info: historyInfo };
        }
    }
    if (profile.providerImageCap !== undefined &&
        countRequestImages(req.messages) + images.length > profile.providerImageCap) {
        info.reason = 'provider_image_cap';
        return { body: pinBody, info };
    }
    const { droppedCodepoints } = accumulateRenderedImages(images, info);
    const topDropped = droppedCodepointsTop(droppedCodepoints);
    if (topDropped)
        info.droppedCodepointsTop = topDropped;
    const imageParts = images.map((img) => openAIImagePart(img, req.model));
    info.imageCount = images.length;
    // GPT savings basis: vision tokens the images actually cost vs the text tokens
    // the same content would have cost unproxied. req.tools is still the original
    // (reassigned to the stripped set below). See src/core/openai-savings.ts.
    info.imageTokens = gptImageTokens(req.model, images);
    info.baselineImagedTokens = staticBaselineTokens;
    info.compressedChars = combinedRaw.length;
    info.bucketChars = { static_slab: combinedRaw.length };
    info.systemSha8 = await sha8(combined);
    info.firstImagePng = images[0].png;
    info.firstImageWidth = images[0].width;
    info.firstImageHeight = images[0].height;
    info.imagePngs = images.map((img) => img.png);
    info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));
    // One slab render may page into multiple PNGs; each page links to the same
    // rendered source. History sources are appended later by foldGptHistory.
    info.imageSourceText = renderedText.slice(0, 65_536);
    info.imageSourceTexts = images.map(() => info.imageSourceText);
    // Verbatim fact-sheet: precision-critical tokens (paths, ids, versions, flags)
    // pulled from the pre-image text so exact strings survive OCR loss. Deterministic
    // → stays inside the cached prefix. See src/core/factsheet.ts.
    const slabFactSheet = factSheetText(combinedRaw, profile.factSheetFormat);
    info.nativeInjectedTokens = systemTexts.reduce((sum) => sum + gptTextTokens(CHAT_POINTER), 0)
        + gptTextTokens('[End of rendered GPT system/tool context.]')
        + gptTextTokens(slabFactSheet);
    const slabUserMsg = {
        role: 'user',
        content: [
            ...imageParts,
            ...(slabFactSheet ? [{ type: 'text', text: slabFactSheet }] : []),
            { type: 'text', text: '[End of rendered GPT system/tool context.]' },
        ],
    };
    req.messages = [
        ...req.messages.slice(0, firstUserIdx),
        slabUserMsg,
        ...req.messages.slice(firstUserIdx),
    ];
    for (const msg of staticMessages) {
        if (msg.role !== 'system' && msg.role !== 'developer')
            continue;
        if (!contentText(msg.content))
            continue;
        setTextContent(msg, CHAT_POINTER);
    }
    // Collapse the OLD conversation prefix into history image(s). The inserted slab
    // item carries static images and is protected; the original opening user prompt
    // remains collapsible history instead of looking like the live request.
    if (o.collapseHistory) {
        await applyChatHistoryCollapse(req, info, o, profile, firstUserIdx + 1);
    }
    if (rewrittenTools !== undefined)
        req.tools = rewrittenTools;
    info.outgoingTextChars = countOutgoingTextChars(req);
    info.compressed = true;
    return { body: new TextEncoder().encode(JSON.stringify(req)), info };
}
export async function transformOpenAIResponses(body, opts = {}) {
    return appendReadNote(await transformOpenAIResponsesInner(body, opts), 'responses', opts);
}
async function transformOpenAIResponsesInner(body, opts = {}) {
    const o = resolveOptions(opts);
    const info = emptyInfo();
    if (!o.compress) {
        info.reason = 'compress=false';
        return { body, info };
    }
    let req;
    try {
        req = JSON.parse(new TextDecoder().decode(body));
    }
    catch (e) {
        info.reason = `parse_error: ${e.message}`;
        return { body, info };
    }
    const pinChars = relocateOpenAIPins(req);
    if (pinChars > 0)
        info.pinChars = pinChars;
    const pinBody = pinChars > 0
        ? new TextEncoder().encode(JSON.stringify(req))
        : body;
    // Normalize input to an array; preserve original string for wrap-back if needed.
    const inputWasString = typeof req.input === 'string';
    const originalInputString = inputWasString ? req.input : undefined;
    let inputItems;
    if (inputWasString) {
        inputItems = [];
    }
    else if (Array.isArray(req.input)) {
        inputItems = req.input;
    }
    else {
        info.reason = 'parse_error: input must be a string or array';
        return { body: pinBody, info };
    }
    // As on the chat path: every stage below reads `.role` / `.content` off each
    // item, so a non-object item threw out of the transform and became a 502.
    if (inputItems.some((item) => !item || typeof item !== 'object')) {
        info.reason = 'invalid_input';
        return { body: pinBody, info };
    }
    // Checkpoints count the original client stream, not an inserted slab item.
    const summarySourceItems = inputItems;
    let summarySlab;
    // Find first user item index (skip non-message items like function_call_output, reasoning).
    const firstUserIdx = inputItems.findIndex((item) => typeof item.role === 'string' &&
        item.role === 'user');
    if (!inputWasString && firstUserIdx < 0) {
        info.reason = 'no_user_message';
        return { body: pinBody, info };
    }
    info.responsesComposition = measureResponsesComposition(req, inputWasString, originalInputString, inputItems);
    // Collect static context: instructions + system/developer items + flat tools.
    const authorityDocs = [];
    const systemTexts = [];
    if (typeof req.instructions === 'string' && req.instructions.length > 0) {
        authorityDocs.push(`## INSTRUCTIONS\n${req.instructions}`);
        systemTexts.push(req.instructions);
        info.staticChars += req.instructions.length;
    }
    // Mid-conversation authority is not static: moving it into the opening
    // slab changes when it takes effect and rewrites cached prefixes on append.
    const openingItems = inputWasString ? [] : inputItems.slice(0, firstUserIdx);
    const staticItems = openingItems.every((item) =>
        (item.role === 'system' || item.role === 'developer') &&
        (typeof item.content === 'string' || (Array.isArray(item.content) &&
            item.content.every((part) => part && part.type === 'input_text' && typeof part.text === 'string' &&
                Object.keys(part).every((k) => k === 'type' || k === 'text')))))
        ? openingItems
        : [];
    for (const item of staticItems) {
        const r = item.role;
        if (r !== 'system' && r !== 'developer')
            continue;
        const content = item.content;
        // content may be a string OR an array of input_text parts (both are valid
        // Responses shapes for system/developer items) — read either form.
        const text = responsesContentText(content);
        if (!text)
            continue;
        authorityDocs.push(`## ${String(r).toUpperCase()} MESSAGE\n${text}`);
        systemTexts.push(text);
        info.staticChars += text.length;
    }
    const { tools: rewrittenTools, docs: toolDocs } = o.compressTools
        ? rewriteFlatToolsForGpt(req.tools)
        : { tools: req.tools, docs: '' };
    const combinedRaw = [...authorityDocs, toolDocs].filter((s) => s.length > 0).join('\n\n');
    info.origChars = combinedRaw.length;
    const profile = resolveGptProfile(req.model);
    const finishSerialized = () => {
        const encoded = new TextEncoder().encode(JSON.stringify(req));
        // The SAME cap the proxy enforces with a 413 (proxy.ts), applied to every
        // profile that declares one. Imaging trades tokens for bytes (base64 PNGs
        // are larger than the text they replace), so a compressed body can exceed a
        // provider's request-size limit even when the original fits. Falling back to
        // the original here turns a hard 413 into a plain uncompressed request.
        const serializedByteLimit = profile.maxSerializedRequestBytes;
        if (serializedByteLimit !== undefined && encoded.byteLength > serializedByteLimit) {
            if (info.gptCacheGate?.history_mode === 'summary')
                info.gptCacheGate = { ...info.gptCacheGate, wire_applied: false,
                    accept: false, reason: 'serialized_request_limit' };
            if (body.byteLength > serializedByteLimit) {
                info.reason = 'serialized_request_limit';
                info.compressed = true;
                return { body, info };
            }
            const fallbackInfo = emptyInfo('serialized_request_limit');
            if (info.gptCacheGate?.history_mode === 'summary')
                fallbackInfo.gptCacheGate = info.gptCacheGate;
            return { body, info: fallbackInfo };
        }
        info.outgoingTextChars = countResponsesOutgoingTextChars(req);
        info.compressed = true;
        return { body: encoded, info };
    };
    const finishHistoryOnly = async (reason) => {
        info.reason = reason;
        if (o.collapseHistory && !inputWasString && await applyResponsesHistoryCollapse(req, inputItems, info, o, profile)) {
            info.reason = undefined;
            return finishSerialized();
        }
        return { body: pinBody, info };
    };
    if (!combinedRaw) {
        return finishHistoryOnly('no_static_context');
    }
    const firstUser = firstResponsesUserText(inputWasString, originalInputString, inputItems);
    if (firstUser)
        info.firstUserSha8 = await sha8(firstUser);
    const combined = compactSlabWhitespace(combinedRaw).trimEnd();
    const minCompressTokens = profile.minCompressTokens;
    const combinedTokens = minCompressTokens === undefined ? undefined : gptTextTokens(combined);
    if (minCompressTokens !== undefined && combinedTokens < minCompressTokens) {
        return finishHistoryOnly(`below_min_tokens (${combinedTokens} < ${minCompressTokens})`);
    }
    if (minCompressTokens === undefined && combined.length < o.minCompressChars) {
        return finishHistoryOnly(`below_min_chars (${combined.length} < ${o.minCompressChars})`);
    }
    const reflowNote = o.reflow
        ? ' The glyph ↵ (U+21B5) marks an original hard line break in content; treat it as a real newline.'
        : '';
    const header = RESPONSES_HEADER.replace('\n====', reflowNote + '\n====');
    const renderedText = prepareImagedRenderText(header + combined, o.reflow);
    const maxCols = o.cols ?? profile.stripCols;
    const cols = Math.min(shrinkColsToContent(renderedText, maxCols, profile.style.markerScale, profile.style.font), profile.stripCols);
    const staticBaselineTokens = gptBaselineImagedTokens(systemTexts, req.tools, rewrittenTools);
    const gate = evalOpenAIGate(req.model, renderedText, cols, o.charsPerToken, opts.charsPerToken === undefined && usesExactStaticBaseline(req.model)
        ? staticBaselineTokens
        : undefined);
    info.gateEval = {
        site: 'slab',
        imageTokens: gate.imageTokens,
        textTokens: gate.textTokens,
        burnImageSide: 0,
        burnTextSide: 0,
        profitable: gate.profitable,
    };
    if (!gate.profitable) {
        info.passthroughReasons = { not_profitable: 1 };
        return finishHistoryOnly(`not_profitable (slab=${combined.length} chars)`);
    }
    const images = await renderTextToPngs(renderedText, cols, profile.style, profile.maxHeightPx);
    if (images.length === 0) {
        info.reason = 'render_empty';
        return { body: pinBody, info };
    }
    const { droppedCodepoints } = accumulateRenderedImages(images, info);
    const topDropped = droppedCodepointsTop(droppedCodepoints);
    if (topDropped)
        info.droppedCodepointsTop = topDropped;
    info.imageCount = images.length;
    // GPT savings basis (see src/core/openai-savings.ts). req.tools is still the
    // original here — reassigned to the stripped set below.
    info.imageTokens = gptImageTokens(req.model, images);
    info.baselineImagedTokens = staticBaselineTokens;
    info.compressedChars = combinedRaw.length;
    info.bucketChars = { static_slab: combinedRaw.length };
    info.systemSha8 = await sha8(combined);
    info.firstImagePng = images[0].png;
    info.firstImageWidth = images[0].width;
    info.firstImageHeight = images[0].height;
    info.imagePngs = images.map((img) => img.png);
    info.imageDims = images.map((img) => ({ width: img.width, height: img.height }));
    // One slab render may page into multiple PNGs; each page links to the same
    // rendered source. History sources are appended later by foldGptHistory.
    info.imageSourceText = renderedText.slice(0, 65_536);
    info.imageSourceTexts = images.map(() => info.imageSourceText);
    const imagePartsResp = images.map((img) => responsesImagePart(img, req.model));
    const endMarker = { type: 'input_text', text: '[End of rendered GPT system/tool context.]', ...responsesCacheBreakpoint(req, profile) };
    // Verbatim fact-sheet (see src/core/factsheet.ts): exact tokens that survive OCR loss.
    const slabFactSheet = factSheetText(combinedRaw, profile.factSheetFormat);
    const slabFactSheetPart = slabFactSheet
        ? [{ type: 'input_text', text: slabFactSheet }]
        : [];
    const authorityPointerCount = (typeof req.instructions === 'string' && req.instructions.length > 0 ? 1 : 0)
        + staticItems.filter((item) => {
            const it = item;
            return (it.role === 'system' || it.role === 'developer')
                && responsesContentText(it.content).length > 0;
        }).length;
    info.nativeInjectedTokens = authorityPointerCount * gptTextTokens(RESPONSES_POINTER)
        + gptTextTokens(slabFactSheet)
        + gptTextTokens(endMarker.text);
    if (inputWasString) {
        // Wrap bare string input into a user item with images prepended.
        req.input = [{
                role: 'user',
                content: [
                    ...imagePartsResp,
                    ...slabFactSheetPart,
                    endMarker,
                    { type: 'input_text', text: originalInputString },
                ],
            }];
    }
    else {
        // Insert a dedicated static-slab item. Do not attach it to the opening real
        // user prompt: that prompt is old history on long stateless Responses calls,
        // and protecting it made stale first-turn requests look live.
        const slabUserItem = {
            role: 'user',
            content: [...imagePartsResp, ...slabFactSheetPart, endMarker],
        };
        summarySlab = { at: firstUserIdx, item: slabUserItem };
        inputItems = [
            ...inputItems.slice(0, firstUserIdx),
            slabUserItem,
            ...inputItems.slice(firstUserIdx),
        ];
        req.input = inputItems;
    }
    // Replace instructions with pointer.
    if (typeof req.instructions === 'string' && req.instructions.length > 0) {
        req.instructions = RESPONSES_POINTER;
    }
    // Replace system/developer input items with a pointer. Mirror the collection
    // gate above for BOTH content shapes: a string becomes the pointer string; an
    // input_text part array keeps its array shape with a single pointer part, so a
    // request the caller sent as parts is not silently reshaped into a string.
    if (!inputWasString) {
        for (const item of staticItems) {
            const it = item;
            if (it.role !== 'system' && it.role !== 'developer')
                continue;
            const content = it.content;
            if (typeof content === 'string') {
                if (content.length > 0)
                    it.content = RESPONSES_POINTER;
            }
            else if (Array.isArray(content) && responsesContentText(content).length > 0) {
                it.content = [{ type: 'input_text', text: RESPONSES_POINTER }];
            }
        }
    }
    // Responses protocol state is not an ordinary contiguous conversation prefix.
    // The profile selects pair-only legacy coverage or mixed safe-message coverage;
    // both preserve recent/open/malformed calls and opaque protocol barriers.
    if (rewrittenTools !== undefined)
        req.tools = rewrittenTools;
    if (o.collapseHistory && !inputWasString) {
        await applyResponsesHistoryCollapse(req, inputItems, info, o, profile,
            { items: summarySourceItems, slab: summarySlab });
    }
    if (rewrittenTools !== undefined)
        req.tools = rewrittenTools;
    // Regression denominator, same as the Chat path — Responses was the only
    // transform that never recorded it.
    return finishSerialized();
}
//# sourceMappingURL=openai.js.map
