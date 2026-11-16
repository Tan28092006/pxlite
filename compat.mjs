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
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  if (hasMarker(body?.system)) return { compact: true, where: 'system' };
  const lastIdx = msgs.findLastIndex((m) => m?.role !== 'system');
  const last = msgs[lastIdx];
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content ?? [];
    if (blocks.some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.includes(COMPACT_MARKER))) {
      return { compact: true, where: 'last-user' };
    }
  }
  const hit = msgs.findLastIndex(hasMarker);
  return { compact: false, where: hit < 0 ? 'other' : `msg-${msgs.length - 1 - hit}-from-end:${msgs[hit]?.role}` };
}

export const isCompactionRequest = (bytes) => classifyCompaction(bytes).compact;

/** Remove every `prompt_cache_breakpoint` key from a JSON request body
 *  (string, Uint8Array or ArrayBuffer); other bodies pass through unchanged. */
export function stripCacheBreakpoints(body) {
  let text = null;
  if (typeof body === 'string') text = body;
  else if (body instanceof Uint8Array || body instanceof ArrayBuffer) text = new TextDecoder().decode(body);
  if (text === null || !text.includes('"prompt_cache_breakpoint"')) return body;
  const out = JSON.stringify(JSON.parse(text), (k, v) => (k === 'prompt_cache_breakpoint' ? undefined : v));
  return typeof body === 'string' ? out : new TextEncoder().encode(out);
}
