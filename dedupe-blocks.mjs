// Drop repeated injected blocks from Claude Messages requests.
// Claude Code and its browser extension paste the same block (for example
// `<browser_instruction>…</browser_instruction>`, about 1,000 tokens) into many user
// messages. The first copy stays byte for byte; each later identical copy becomes one
// marker line. Text the user typed around the block, in the same text block, stays.
// - Full body (whole history in the request): only copies repeated within that body are
//   replaced. The history prefix is the same on every request, so the replacement is the
//   same on every request and the cached prefix stays stable.
// - Delta body (history kept server-side, only new messages sent): a copy whose hash was
//   already seen in the same conversation is replaced too; the first copy already sits
//   in the server-side history. A resent message (a retry of the same delta) keeps it.
// Only hashes are kept, per conversation, in a bounded LRU; never block text.
import crypto from 'node:crypto';

export const DEFAULT_DEDUPE_TAGS = ['browser_instruction'];
// <system-reminder> carries CLAUDE.md and must never be touched, even if configured.
const NEVER = new Set(['system-reminder']);
const TAG_NAME = /^[A-Za-z_][\w.-]*$/;

/** PXLITE_DEDUPE_TAGS: unset → default list; '' or '0' → off; else comma-separated tag names. */
export function parseDedupeTags(raw) {
  if (raw === undefined) return [...DEFAULT_DEDUPE_TAGS];
  const s = raw.trim();
  if (!s || s === '0') return [];
  return [...new Set(s.split(',').map((t) => t.trim()).filter((t) => TAG_NAME.test(t) && !NEVER.has(t)))];
}

export const dedupeMarker = (tag) => `[${tag} lặp lại nguyên văn bản ở lượt trước — đã lược]`;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ tags: string[], maxSessions?: number, maxHashesPerSession?: number }} opts
 * apply(body, { sessionKey, bodyKind }) mutates body.messages in place and returns the
 * number of blocks replaced (0 when nothing changed).
 */
export function createBlockDedupe({ tags, maxSessions = 500, maxHashesPerSession = 256 }) {
  const stats = { requests: 0, replaced: 0, charsSaved: 0 };
  // sessionKey → Map(blockHash → hash of the message that carried the first copy)
  const sessions = new Map();
  const re = tags.length ? new RegExp(`<(${tags.map(escapeRe).join('|')})>[\\s\\S]*?</\\1>`, 'g') : null;

  const sessionMap = (key) => {
    let m = sessions.get(key);
    if (m) {
      sessions.delete(key); // move to most recent
    } else {
      m = new Map();
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    }
    sessions.set(key, m);
    return m;
  };

  function apply(body, { sessionKey, bodyKind } = {}) {
    if (!re || !Array.isArray(body?.messages)) return 0;
    stats.requests += 1;
    const seenInBody = new Set();
    const mem = sessionKey ? sessionMap(sessionKey) : null;
    const useMemory = mem && bodyKind === 'delta';
    let replaced = 0;
    const rewrite = (text, msgHash) =>
      text.replace(re, (block, tag) => {
        const h = sha(block);
        const first = mem?.get(h);
        if (seenInBody.has(h) || (useMemory && first !== undefined && first !== msgHash)) {
          replaced += 1;
          const marker = dedupeMarker(tag);
          stats.charsSaved += block.length - marker.length;
          return marker;
        }
        seenInBody.add(h);
        if (mem && first === undefined) {
          if (mem.size >= maxHashesPerSession) mem.delete(mem.keys().next().value);
          mem.set(h, msgHash);
        }
        return block;
      });
    for (const msg of body.messages) {
      if (msg?.role !== 'user') continue;
      const msgHash = sha(JSON.stringify(msg.content ?? null));
      if (typeof msg.content === 'string') {
        msg.content = rewrite(msg.content, msgHash);
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) if (b?.type === 'text' && typeof b.text === 'string') b.text = rewrite(b.text, msgHash);
      }
    }
    stats.replaced += replaced;
    return replaced;
  }

  return { apply, stats, sessionCount: () => sessions.size };
}
