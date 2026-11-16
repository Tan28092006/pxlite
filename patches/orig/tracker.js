/**
 * Runtime-agnostic event sink for pxpipe.
 * Per-request JSONL record — same shape on Node (file) and Workers (console.log).
 * Never emits raw text; only sizes, counts, durations, env fields, and sha256 prefixes.
 */
import { bytesToBase64 } from './png.js';
/** Max inline base64 body per JSONL row (32 KiB). Larger goes to sidecar (Node) or is dropped (Workers). */
export const TRACK_BODY_INLINE_MAX = 32 * 1024;
/** Convert a ProxyEvent to its flat persisted shape. Shared in core so Node/Worker hosts stay in sync. */
export function toTrackEvent(ev) {
    const info = ev.info;
    const env = info?.env;
    const u = ev.usage;
    const out = {
        ts: new Date().toISOString(),
        method: ev.method,
        path: ev.path,
        status: ev.status,
        duration_ms: ev.durationMs,
    };
    if (ev.model)
        out.model = ev.model;
    if (ev.accountingProvider)
        out.accounting_provider = ev.accountingProvider;
    if (ev.firstByteMs !== undefined)
        out.first_byte_ms = ev.firstByteMs;
    if (ev.transformMs !== undefined)
        out.transform_ms = ev.transformMs;
    if (ev.error)
        out.error = ev.error;
    if (ev.errorBody)
        out.error_body = ev.errorBody;
    if (ev.reqBodySha8)
        out.req_body_sha8 = ev.reqBodySha8;
    // Body sample: sidecar path (Node) > inline base64 if it fits > drop (Workers, oversized).
    if (ev.reqBodySamplePath) {
        out.req_body_sample_path = ev.reqBodySamplePath;
    }
    else if (ev.reqBodyGz && ev.reqBodyGz.byteLength > 0) {
        const b64 = bytesToBase64(ev.reqBodyGz);
        if (b64.length <= TRACK_BODY_INLINE_MAX) {
            out.req_body_sample_b64 = b64;
        }
    }
    if (info) {
        if (info.compressed !== undefined)
            out.compressed = info.compressed;
        if (info.reason)
            out.reason = info.reason;
        if (info.origChars !== undefined)
            out.orig_chars = info.origChars;
        if (info.compressedChars !== undefined && info.compressedChars > 0) {
            out.compressed_chars = info.compressedChars;
        }
        if (info.imageCount !== undefined)
            out.image_count = info.imageCount;
        // Only when nonzero: a wire without client images is the common case and
        // should not pay a key per event.
        if ((info.nativeImages ?? 0) > 0)
            out.native_images = info.nativeImages;
        if ((info.imageBudgetSkips ?? 0) > 0)
            out.image_budget_skips = info.imageBudgetSkips;
        // Emit only when it disagrees with the render counter: equality is the common
        // case and a per-event key for "nothing to see" is noise.
        if (info.wireImages !== undefined
            && info.wireImages !== (info.imageCount ?? 0) + (info.nativeImages ?? 0)) {
            out.wire_images = info.wireImages;
        }
        if (info.imageBytes !== undefined)
            out.image_bytes = info.imageBytes;
        if (info.imagePixels !== undefined && info.imagePixels > 0) {
            out.image_pixels = info.imagePixels;
        }
        if (info.imageTokens !== undefined && info.imageTokens > 0) {
            out.image_tokens = info.imageTokens;
        }
        if (info.baselineImagedTokens !== undefined && info.baselineImagedTokens > 0) {
            out.baseline_imaged_tokens = info.baselineImagedTokens;
        }
        if (info.nativeInjectedTokens !== undefined && info.nativeInjectedTokens > 0) {
            out.native_injected_tokens = info.nativeInjectedTokens;
        }
        if (info.outgoingTextChars !== undefined && info.outgoingTextChars > 0) {
            out.outgoing_text_chars = info.outgoingTextChars;
        }
        if (info.pinChars !== undefined && info.pinChars > 0) {
            out.pin_chars = info.pinChars;
        }
        if (info.responsesComposition) {
            out.responses_composition = info.responsesComposition;
        }
        if (info.staticChars !== undefined)
            out.static_chars = info.staticChars;
        if (info.dynamicChars !== undefined)
            out.dynamic_chars = info.dynamicChars;
        if (info.dynamicBlockCount !== undefined)
            out.dynamic_block_count = info.dynamicBlockCount;
        if (info.toolResultImgs !== undefined)
            out.tool_result_imgs = info.toolResultImgs;
        if (info.toolDocsChars !== undefined)
            out.tool_docs_chars = info.toolDocsChars;
        if (info.truncatedToolResults !== undefined && info.truncatedToolResults > 0) {
            out.truncated_tool_results = info.truncatedToolResults;
        }
        if (info.omittedChars !== undefined && info.omittedChars > 0) {
            out.omitted_chars = info.omittedChars;
        }
        if (info.collapsedTurns !== undefined && info.collapsedTurns > 0) {
            out.collapsed_turns = info.collapsedTurns;
        }
        if (info.collapsedChars !== undefined && info.collapsedChars > 0) {
            out.collapsed_chars = info.collapsedChars;
        }
        if (info.collapsedImages !== undefined && info.collapsedImages > 0) {
            out.collapsed_images = info.collapsedImages;
        }
        if (info.historyReason !== undefined) {
            out.history_reason = info.historyReason;
        }
        if (info.historyFreezeStep !== undefined)
            out.history_freeze_step = info.historyFreezeStep;
        if (info.historyBudgetTrimmed)
            out.history_budget_trimmed = true;
        if (info.historyPackFill)
            out.history_pack_fill = true;
        if (info.droppedChars !== undefined && info.droppedChars > 0) {
            out.dropped_chars = info.droppedChars;
        }
        if (info.droppedCodepointsTop && Object.keys(info.droppedCodepointsTop).length > 0) {
            out.dropped_codepoints_top = info.droppedCodepointsTop;
        }
        if (info.passthroughReasons) {
            const pr = info.passthroughReasons;
            if (Object.values(pr).some((n) => (n ?? 0) > 0)) {
                out.passthrough_reasons = pr;
            }
        }
        if (info.bucketChars && Object.keys(info.bucketChars).length > 0) {
            // Omit empty object so noop-pass requests stay lean; presence means at least one gate fired.
            out.bucket_chars = info.bucketChars;
        }
        if (info.historyTextChars !== undefined && info.historyTextChars > 0) {
            out.history_text_chars = info.historyTextChars;
        }
        if (info.historyImageSha) {
            out.history_image_sha8 = info.historyImageSha;
        }
        if (info.cachePrefixSha8)
            out.cache_prefix_sha8 = info.cachePrefixSha8;
        if (info.cachePrefixBytes !== undefined)
            out.cache_prefix_bytes = info.cachePrefixBytes;
        if (info.cachePrefixToolsSha8)
            out.cache_prefix_tools_sha8 = info.cachePrefixToolsSha8;
        if (info.cachePrefixSystemSha8)
            out.cache_prefix_system_sha8 = info.cachePrefixSystemSha8;
        if (info.cachePrefixHeadSha8)
            out.cache_prefix_head_sha8 = info.cachePrefixHeadSha8;
        if (info.cachePrefixMarkedSha8)
            out.cache_prefix_marked_sha8 = info.cachePrefixMarkedSha8;
        if (info.cachePrefixMarkedBytes !== undefined)
            out.cache_prefix_marked_bytes = info.cachePrefixMarkedBytes;
        if (info.cachePrefixMarkerPos)
            out.cache_prefix_marker_pos = info.cachePrefixMarkerPos;
        if (info.unknownStaticTags && info.unknownStaticTags.length > 0)
            out.unknown_static_tags = info.unknownStaticTags;
        if (info.churningStaticTags && info.churningStaticTags.length > 0)
            out.churning_static_tags = info.churningStaticTags;
        if (info.systemSha8)
            out.system_sha8 = info.systemSha8;
        if (info.firstUserSha8)
            out.first_user_sha8 = info.firstUserSha8;
        if (info.baselineTokens !== undefined && info.baselineTokens > 0) {
            out.baseline_tokens = info.baselineTokens;
        }
        if (info.baselineCacheableTokens !== undefined
            && info.baselineCacheableTokens > 0) {
            out.baseline_cacheable_tokens = info.baselineCacheableTokens;
        }
        if (info.baselineProbeStatus !== undefined) {
            out.baseline_probe_status = info.baselineProbeStatus;
        }
    }
    if (env) {
        if (env.cwd)
            out.cwd = env.cwd;
        if (env.isGitRepo !== undefined)
            out.is_git_repo = env.isGitRepo;
        if (env.gitBranch)
            out.git_branch = env.gitBranch;
        if (env.platform)
            out.platform = env.platform;
        if (env.osVersion)
            out.os_version = env.osVersion;
        if (env.today)
            out.today = env.today;
    }
    if (u) {
        if (u.input_tokens !== undefined)
            out.input_tokens = u.input_tokens;
        if (u.output_tokens !== undefined)
            out.output_tokens = u.output_tokens;
        if (u.cache_creation_input_tokens !== undefined)
            out.cache_create_tokens = u.cache_creation_input_tokens;
        if (u.cache_read_input_tokens !== undefined)
            out.cache_read_tokens = u.cache_read_input_tokens;
        if (u.cached_tokens !== undefined)
            out.cached_tokens = u.cached_tokens;
        if (u.cache_write_tokens !== undefined)
            out.cache_write_tokens = u.cache_write_tokens;
        // cache_creation splits cache_creation_input_tokens across 5-min (1.25x) and 1-hour (2x) tiers.
        if (u.cache_creation) {
            if (u.cache_creation.ephemeral_5m_input_tokens !== undefined)
                out.cache_create_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
            if (u.cache_creation.ephemeral_1h_input_tokens !== undefined)
                out.cache_create_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
        }
        if (u.server_tool_use?.web_search_requests !== undefined)
            out.web_search_requests = u.server_tool_use.web_search_requests;
    }
    const m = ev.measurement;
    if (m) {
        if (m.textChars > 0)
            out.text_chars_measured = m.textChars;
        if (m.thinkingChars > 0)
            out.thinking_chars_measured = m.thinkingChars;
        if (m.toolUseChars > 0)
            out.tool_use_chars_measured = m.toolUseChars;
        if (m.redactedBlockCount > 0)
            out.redacted_block_count_measured = m.redactedBlockCount;
    }
    if (ev.stopReason) {
        out.stop_reason = ev.stopReason;
        if (SAFETY_STOP_REASONS.has(ev.stopReason))
            out.safety_flagged = true;
    }
    return out;
}
/** Stop reasons that mean a safety classifier fired (Anthropic / OpenAI spellings). */
const SAFETY_STOP_REASONS = new Set(['refusal', 'content_filter']);
/** Writes one JSON line per event. Worker host uses console.log; Node host uses a file-backed variant. */
export class JsonLogTracker {
    sink;
    constructor(sink = (s) => console.log(s)) {
        this.sink = sink;
    }
    emit(ev) {
        try {
            this.sink(JSON.stringify(ev));
        }
        catch {
            /* swallow — tracker must never break a request */
        }
    }
}
/** Tracker that drops everything. Used when PXPIPE_TRACK=0. */
export const noopTracker = { emit() { } };
//# sourceMappingURL=tracker.js.map