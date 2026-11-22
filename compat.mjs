// Request fixes for upstreams that reject fields pxpipe adds, and for clients
// that compress request bodies pxpipe needs to read.
import zlib from 'node:zlib';

const DECODERS = {
  zstd: (b) => zlib.zstdDecompressSync(b),
  gzip: (b) => zlib.gunzipSync(b),
  br: (b) => zlib.brotliDecompressSync(b),
  deflate: (b) => zlib.inflateSync(b),
};

/** Decode a request body sent with one Content-Encoding pxpipe cannot read.
 *  Returns the plain bytes, or null when the encoding is absent or unknown. */
export function decodeRequestBody(encoding, bytes) {
  const decode = DECODERS[(encoding ?? '').trim().toLowerCase()];
  return decode ? decode(bytes) : null;
}

// Claude Code's /compact (and auto-compact) request ends with a user message that
// starts its summary instruction with this phrase (all three variants share it).
const COMPACT_MARKER = 'Your task is to create a detailed summary of';

const hasMarker = (x) => x != null && JSON.stringify(x).includes(COMPACT_MARKER);

/**
 * Classify an Anthropic Messages body against Claude Code's compaction prompt.
 * `compact` is true when the marker sits in the system prompt or in the last
 * non-system message, which must be a user turn (Claude Code 2026-11 may append a
 * role "system" message after it). Earlier turns may only quote the phrase (a
 * session that discusses compaction), so they do not count.
 * `where` names the marker's position (no content) whenever the marker occurs, so a
 * missed compaction shape shows up in /pxlite/status.
 * @param {Uint8Array} bytes
 * @returns {{compact: boolean, where: string | null}}
 */
export function classifyCompaction(bytes) {
  const none = { compact: false, where: null };
  if (!bytes || Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(COMPACT_MARKER) < 0) return none;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { compact: false, where: 'unparsable' };
  }
  const msgs = Array.isArray(body?.messages) ? body.messages
    : Array.isArray(body?.input) ? body.input
    : typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : [];
  if (hasMarker(body?.system)) return { compact: true, where: 'system' };
  if (hasMarker(body?.instructions)) return { compact: true, where: 'instructions' };
  const lastIdx = msgs.findLastIndex((m) => m?.role !== 'system');
  const last = msgs[lastIdx];
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content ?? [];
    if (blocks.some((b) => (b?.type === 'text' || b?.type === 'input_text') && typeof b.text === 'string' && b.text.includes(COMPACT_MARKER))) {
      return { compact: true, where: 'last-user' };
    }
  }
  const hit = msgs.findLastIndex(hasMarker);
  return { compact: false, where: hit < 0 ? 'other' : `msg-${msgs.length - 1 - hit}-from-end:${msgs[hit]?.role}` };
}

export const isCompactionRequest = (bytes) => classifyCompaction(bytes).compact;

/** Backend-specific compatibility, not a global cache opt-out. Without a URL,
 * retain the legacy strip behavior for callers that explicitly request it.
 * Both the public Responses route and Codex reject pxpipe's cache anchor for Sol.
 * Never touch a tool schema/property or JSON arguments that happen to use the name. */
export function stripCacheBreakpoints(body, { url } = {}) {
  let backend;
  if (url) {
    let u;
    try { u = new URL(url); } catch { return body; }
    if (u.protocol !== 'https:') return body;
    if (u.hostname === 'api.openai.com' && /^\/v1\/responses(?:\/|$)/.test(u.pathname)) backend = 'api';
    else if (u.hostname === 'chatgpt.com' && /^\/backend-api\/codex\/responses(?:\/|$)/.test(u.pathname)) backend = 'codex';
    else return body;
  }
  let text = null;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array || body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  if (text === null || !text.includes('"prompt_cache_breakpoint"')) return body;
  const req = JSON.parse(text);
  // A caller deliberately selecting explicit-only caching owns that decision.
  // Leave it intact (including any upstream rejection), rather than silently
  // sending explicit mode with no anchors and turning caching off.
  if (backend && req.prompt_cache_options?.mode === 'explicit') return body;
  let changed = false;
  const strip = part => {
    if (part && typeof part === 'object' && Object.hasOwn(part, 'prompt_cache_breakpoint')) {
      delete part.prompt_cache_breakpoint;
      changed = true;
    }
  };
  strip(req);
  for (const item of Array.isArray(req.input) ? req.input : []) {
    strip(item);
    for (const parts of [item?.content, item?.output])
      if (Array.isArray(parts)) for (const part of parts) strip(part);
  }
  if (!changed) return body;
  const out = JSON.stringify(req);
  return typeof body === 'string' ? out : new TextEncoder().encode(out);
}
