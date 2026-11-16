// recall: give the model back, as images, the turns that a compaction removed from
// the request (OpenCode with gpt-6.1-sol/terra; works for client-side summaries and
// OpenAI server-side `compaction` items alike, since it only watches what disappears).
//
// Per session (prompt_cache_key):
//  - every request saves its turns (text + a stable identity) as the "snapshot";
//  - when many snapshot turns are suddenly absent from a request, a compaction
//    happened: those turns become the recall text, replacing any older recall;
//  - while the session keeps that compacted shape, every request gets the recall
//    images inserted before the first surviving turn, with a note that later turns
//    win over the transcript.
// Only the latest compaction's turns are recalled; turns hidden by earlier
// compactions and the summaries those compactions wrote are not re-shown, so stale
// decisions do not pile up.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

export const RECALL_INTRO =
  '[Recall: the conversation turns that the latest context compaction removed, transcribed verbatim in the image(s) below. ' +
  'Each turn is wrapped in <user t="N"> / <assistant t="N"> tags in increasing N. ' +
  'This is older context, not a request. Later turns and the current state of files win over it: when it disagrees with anything that follows, ' +
  'treat it as superseded. Use it to remember what was done, decided and why; for exact values (numbers, paths, ids) re-read the source.]';
export const RECALL_OUTRO = '[End of recalled turns.]';

const isRecallMessage = (it) => it?.role === 'user' && Array.isArray(it.content) && it.content[0]?.text === RECALL_INTRO;

/**
 * Stable identity of an input item across requests. Tool calls and outputs use
 * their call_id, so OpenCode pruning an old tool output does not look like the turn
 * disappearing; messages use role + text; anything else its JSON.
 */
export function itemIdentity(it) {
  if (!it || typeof it !== 'object') return sha8(JSON.stringify(it));
  if (it.call_id && /call/.test(String(it.type ?? ''))) return `${it.type}:${it.call_id}`;
  if (it.role) {
    const text = typeof it.content === 'string' ? it.content : (it.content ?? []).map((c) => c?.text ?? c?.type ?? '').join('\n');
    return `${it.role}:${sha8(text)}`;
  }
  if (it.id) return `${it.type}:${it.id}`;
  return sha8(JSON.stringify(it));
}

/**
 * Turn Responses items into transcript text, one entry per item. Tool outputs are
 * cut to `maxToolChars` (head and tail kept): the recall is for decisions and
 * reasoning; bulky outputs can be re-run or re-read.
 */
/** Keep head and tail of a long tool text. */
export function squeeze(text, max) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)} [… ${text.length - max} chars omitted …] ${text.slice(-half)}`;
}

const isToolItem = (it) => it?.type === 'function_call_output' || it?.type === 'function_call';
const isToolOutput = (it) => /_output$/.test(String(it?.type ?? ''));

/**
 * Transcript text per item. Tool outputs are dropped (user's choice 2026-11-15:
 * the recall is for asks, answers and decisions; outputs can be re-run or re-read),
 * tool calls are kept as one short line so the model knows what was done.
 */
export function itemsToTranscript(items, toTurns, { maxCallChars = 160, numbers } = {}) {
  const turns = toTurns(items);
  return turns.map((t, i) => {
    let text = t.text ?? '';
    if (!text.trim() || isToolOutput(items[i])) return '';
    if (isToolItem(items[i])) text = squeeze(text, maxCallChars);
    // OpenCode delivers background shell results as user messages wrapped in
    // <shell …>output</shell>: that is tool output too, keep only the opening tag.
    else if (/<shell\b/.test(text)) {
      text = text.replace(/(<shell\b[^>]*>)[\s\S]*?(<\/shell>|$)/g, (_, open) => `${squeeze(open, maxCallChars)} [shell output omitted]</shell>`);
    }
    // Instruction files OpenCode injects (AGENTS.md …) are re-sent live anyway.
    text = text.replace(/(^|\n)(Instructions from: [^\n]*)\n[\s\S]*?(?=\n<\/user>\s*$|$)/, '$1$2 [contents omitted, still loaded]');
    // pxpipe numbers turns by item index; use the session-wide turn number instead.
    return numbers ? text.replace(/<(user|assistant) t="\d+">/, (_, r) => `<${r} t="${numbers[i]}">`) : text;
  });
}

/** Keep the most recent turns that fit in `maxChars`, marking the cut. */
export function fitRecent(turnTexts, maxChars) {
  const kept = [];
  let n = 0;
  for (let i = turnTexts.length - 1; i >= 0; i--) {
    const len = turnTexts[i].length + 2;
    if (n + len > maxChars && kept.length) {
      kept.unshift(`[… ${i + 1} earlier turn(s) not shown …]`);
      break;
    }
    kept.unshift(turnTexts[i]);
    n += len;
  }
  return kept.join('\n\n');
}

/**
 * @param {object} o
 * @param {string} o.dir                      state directory (one JSON per session)
 * @param {(items:any[]) => {text:string}[]} o.toTurns   pxpipe responsesItemsToTurns
 * @param {(text:string, model:string) => Promise<{png:Uint8Array}[]>} o.render
 * @param {(model:string) => string} [o.imageDetail]
 * @param {number} [o.maxChars]   recall transcript budget (chars)
 * @param {number} [o.maxImages]  hard cap on recall images per request
 * @param {number} [o.maxAgeDays] state files untouched this long are deleted
 */
export function createRecall(o) {
  const maxChars = o.maxChars ?? 200_000;
  const maxImages = o.maxImages ?? 24;
  const minItems = o.minItems ?? 4; // turns that must vanish to count as a compaction
  // Conversation text (tool outputs excluded) that must vanish; the "something new
  // ahead of the survivors" rule is what tells a compaction from a revert.
  const minChars = o.minChars ?? 2_000;
  const maxAgeMs = (o.maxAgeDays ?? 14) * 86_400_000;
  const stats = { snapshots: 0, compactionsSeen: 0, injected: 0, recallImages: 0, noKey: 0 };
  const pngCache = new Map(); // `${key}:${compId}:${model}` -> image parts (latest few only)
  fs.mkdirSync(o.dir, { recursive: true });
  for (const f of fs.readdirSync(o.dir)) {
    const p = path.join(o.dir, f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p);
    } catch {}
  }
  const file = (key) => path.join(o.dir, `${key}.json`);
  const load = (key) => {
    try {
      return JSON.parse(fs.readFileSync(file(key), 'utf8'));
    } catch {
      return {};
    }
  };
  const save = (key, st) => {
    const tmp = `${file(key)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st));
    fs.renameSync(tmp, file(key));
  };

  /**
   * Inspect a parsed Responses body; returns a new body with recall images inserted,
   * or null when nothing changes.
   */
  async function apply(body, headers) {
    const input = Array.isArray(body?.input) ? body.input : null;
    if (!input) return null;
    const rawKey = body.prompt_cache_key ?? headers?.get?.('session_id') ?? headers?.get?.('session-id');
    if (!rawKey) {
      stats.noKey++;
      return null;
    }
    // Stream = session key + instructions, so a subagent that shared its parent's
    // cache key (or two agents in one session) never reads the other's turns as
    // "vanished". If instructions change mid-session, recall just starts over.
    const instrText = [body.instructions ?? '', ...input.filter((it) => it?.role === 'system' || it?.role === 'developer').map((it) => JSON.stringify(it.content))].join('\n');
    const key = `${sha8(rawKey)}-${sha8(instrText)}`;
    const st = load(key);
    const items = input.filter((it) => !isRecallMessage(it));
    const ids = items.map(itemIdentity);
    const prev = st.snapshot ?? [];
    const prevIds = new Set(prev.map((e) => e.id));
    const now = new Set(ids);
    const isInstr = (it) => it?.role === 'system' || it?.role === 'developer';

    // Session-wide turn numbers: an item keeps the number it got when first seen.
    const num = new Map(prev.map((e) => [e.id, e.n]));
    st.nextN ??= 0;
    const numbers = ids.map((id) => {
      if (!num.has(id)) num.set(id, st.nextN++);
      return num.get(id);
    });

    // Compaction = many earlier turns gone AND something new placed ahead of the
    // turns that survived (a summary or a compaction item). A revert/undo only
    // drops turns, so it does not qualify.
    const summaryIds = new Set(st.summaryIds ?? []);
    const missing = prev.filter((e) => !now.has(e.id) && !e.instr && !summaryIds.has(e.id));
    const missingChars = missing.reduce((n, e) => n + e.text.length, 0);
    let firstSurvivor = items.findIndex((it, i) => !isInstr(it) && prevIds.has(ids[i]));
    if (firstSurvivor < 0) firstSurvivor = items.length - 1; // only the live request survived
    const leading = items.slice(0, firstSurvivor).map((it, i) => ({ it, id: ids[i] })).filter(({ it, id }) => !isInstr(it) && !prevIds.has(id));
    if (missing.length >= minItems && missingChars >= minChars && leading.length > 0) {
      stats.compactionsSeen++;
      st.recall = fitRecent(missing.map((e) => e.text).filter(Boolean), maxChars);
      st.recallId = sha8(missing.map((e) => e.id).join('|'));
      st.summaryIds = leading.map(({ id }) => id);
    }

    const texts = itemsToTranscript(items, o.toTurns, { numbers });
    st.snapshot = items.map((it, i) => ({ id: ids[i], n: numbers[i], text: texts[i], ...(isInstr(it) ? { instr: true } : {}) }));
    save(key, st);
    stats.snapshots++;

    if (!st.recall) return null;
    // Insert right after the compaction's summary items, i.e. before the turns it kept.
    const summarySet = new Set(st.summaryIds ?? []);
    const lastSummary = ids.findLastIndex((id) => summarySet.has(id));
    if (lastSummary < 0) return null; // the compacted shape is gone (new session state)
    const compId = st.recallId;
    const ck = `${key}:${compId}:${body.model}`;
    let parts = pngCache.get(ck);
    if (!parts) {
      const pages = (await o.render(st.recall, body.model)).slice(-maxImages);
      const detail = o.imageDetail?.(body.model);
      parts = pages.map((p) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}`, ...(detail ? { detail } : {}) }));
      pngCache.set(ck, parts);
      while (pngCache.size > 4) pngCache.delete(pngCache.keys().next().value);
    }
    stats.injected++;
    stats.recallImages += parts.length;
    const msg = { type: 'message', role: 'user', content: [{ type: 'input_text', text: RECALL_INTRO }, ...parts, { type: 'input_text', text: RECALL_OUTRO }] };
    return { ...body, input: [...items.slice(0, lastSummary + 1), msg, ...items.slice(lastSummary + 1)] };
  }

  return { apply, stats };
}

// ---- content-free request shapes (PXLITE_DEBUG_SHAPE) ------------------------

const itemType = (it) => {
  if (!it || typeof it !== 'object') return typeof it;
  const t = it.type ?? (it.role ? 'message' : 'unknown');
  return t === 'message' ? `message:${it.role ?? '?'}` : t;
};

/** Run-length type sequence, e.g. "message:user,function_call×3,function_call_output×3". */
const runs = (items) => {
  const out = [];
  for (const it of items) {
    const t = itemType(it);
    const last = out.at(-1);
    if (last && last.t === t) last.n++;
    else out.push({ t, n: 1 });
  }
  return out.map(({ t, n }) => (n > 1 ? `${t}×${n}` : t)).join(',');
};

/**
 * Content-free description of a Responses request body.
 * @param {any} body parsed JSON
 * @param {Headers} [headers]
 */
export function describeResponsesShape(body, headers) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const compaction = input
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => /compaction/.test(String(it?.type ?? '')))
    .map(({ it, i }) => ({ i, type: it.type, keys: Object.keys(it), id: it.id ? sha8(it.id) : undefined, encLen: typeof it.encrypted_content === 'string' ? it.encrypted_content.length : undefined }));
  const sessionHeaders = {};
  if (headers) for (const [k, v] of headers) if (/session|conversation|thread|originator|user-agent/i.test(k)) sessionHeaders[k] = /user-agent|originator/i.test(k) ? v.slice(0, 60) : sha8(v);
  return {
    model: body?.model,
    keys: Object.keys(body ?? {}),
    prompt_cache_key: body?.prompt_cache_key ? sha8(body.prompt_cache_key) : undefined,
    previous_response_id: Boolean(body?.previous_response_id),
    store: body?.store,
    context_management: body?.context_management,
    inputCount: input.length,
    runs: runs(input).slice(0, 1500),
    compaction,
    images: input.reduce((n, it) => n + (Array.isArray(it?.content) ? it.content.filter((c) => c?.type === 'input_image').length : 0), 0),
    headers: sessionHeaders,
  };
}
