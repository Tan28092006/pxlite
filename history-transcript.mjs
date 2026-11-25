// Text copy of the Claude turns pxlite turned into history images: one file per conversation
// under ~/.pxpipe/transcripts, so an agent that cannot read a value off an image searches the
// file (rg) instead of guessing or re-running tools. The images drop tool output; this keeps it.
//
// Cache rule: the pointer line sent upstream is a constant per conversation and starts only on
// a request whose bytes after the last history image are being rewritten anyway (the first
// collapse or a checkpoint advance). A conversation that was already collapsed when the proxy
// first saw it gets no pointer until its next checkpoint. Once started, the sidecar file keeps
// the pointer on across proxy restarts, so it never appears or disappears mid-epoch.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const safeName = (s) => String(s).replace(/[^\w.-]+/g, '_').slice(0, 120);
const blocksOf = (m) => (Array.isArray(m?.content) ? m.content : []);

/** Structure only (roles, block types, tool ids): later stages may shorten old tool output,
 *  which must not look like a different conversation. */
export function shapeOf(m) {
  if (!m || typeof m !== 'object') return 'none';
  if (typeof m.content === 'string') return sha(`${m.role}|s|${m.content.slice(0, 200)}`);
  return sha(`${m.role}|${blocksOf(m).map((b) => `${b?.type}:${b?.id ?? b?.tool_use_id ?? ''}`).join(',')}`);
}

function innerText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

/** One message as text, or '' when it carries nothing readable (thinking only). */
export function turnText(m, index, names) {
  const parts = [];
  if (typeof m?.content === 'string') parts.push(m.content);
  for (const b of blocksOf(m)) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use') {
      let args;
      try { args = JSON.stringify(b.input); } catch { args = String(b.input); }
      parts.push(`[tool_use ${b.name}] ${args}`);
    } else if (b.type === 'tool_result') {
      parts.push(`[tool_result ${names.get(b.tool_use_id) ?? 'tool'}${b.is_error === true ? ' (error)' : ''}]\n${innerText(b.content)}`);
    } else if (b.type === 'image') parts.push('[image]');
    else if (b.type === 'document') parts.push('[document]');
  }
  const body = parts.join('\n').trim();
  if (!body) return '';
  const tag = m.role === 'assistant' ? 'assistant' : 'user';
  return `<${tag} t="${index}">\n${body}\n</${tag}>\n\n`;
}

function rangeText(messages, from, to) {
  const names = new Map();
  for (let i = 0; i < to; i++) {
    for (const b of blocksOf(messages[i])) if (b?.type === 'tool_use' && typeof b.id === 'string') names.set(b.id, b.name);
  }
  let out = '';
  for (let i = from; i < to; i++) out += turnText(messages[i], i, names);
  return out;
}

/** The one line sent upstream. A function of the file path only, so it never changes. */
export function transcriptNote(file) {
  const f = file.replace(/\\/g, '/');
  return `[Text copy of the earlier turns pictured above, including their tool calls and tool output: ${f} ` +
    `- when a value in an image is unclear or you need an exact string, search that file instead of guessing ` +
    `(rg -n -C2 "<term>" "${f}"). Turns carry the same <user t="N"> / <assistant t="N"> tags. ` +
    `The file can be large: search it, do not read it whole.]`;
}

export function createHistoryTranscript({ dir, maxAgeDays = 14, maxSeen = 500, now = Date.now } = {}) {
  const seen = new Map(); // key -> { to, len }: what this process last saw, never persisted
  const metas = new Map(); // key -> sidecar contents, or null when the pointer is not started
  const stats = { started: 0, appended: 0, rewritten: 0, steady: 0, waiting: 0, errors: 0 };
  let pruned = false;

  const files = (key) => {
    const file = path.join(dir, `${safeName(key)}.txt`);
    return { file, metaFile: `${file}.meta.json` };
  };
  const prune = () => {
    if (pruned) return;
    pruned = true;
    try {
      const cutoff = now() - maxAgeDays * 86_400_000;
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      }
    } catch {}
  };
  const loadMeta = (key) => {
    if (metas.has(key)) return metas.get(key);
    let meta = null;
    try {
      const { file, metaFile } = files(key);
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (Number.isSafeInteger(m?.from) && Number.isSafeInteger(m?.to) && fs.existsSync(file)) meta = m;
    } catch {}
    metas.set(key, meta);
    return meta;
  };
  const saveMeta = (key, meta) => {
    fs.writeFileSync(files(key).metaFile, JSON.stringify(meta), { mode: 0o600 });
    metas.set(key, meta);
  };
  const writeAll = (key, messages, from, to) => {
    fs.mkdirSync(dir, { recursive: true });
    prune();
    const { file } = files(key);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `# pxlite text copy of collapsed turns. Search it (rg); turns are tagged t="N".\n\n${rangeText(messages, from, to)}`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    saveMeta(key, { v: 1, from, to, head: shapeOf(messages[from]), last: shapeOf(messages[to - 1]) });
  };

  return {
    dir,
    stats: () => ({ ...stats }),
    fileFor: (key) => files(key).file,

    /** Call on every request of a conversation; `to <= from` means nothing was collapsed.
     *  Returns { note, state }: note is the pointer line to send, or null. */
    note({ key, messages, from, to }) {
      try {
        if (!key || !Array.isArray(messages)) return { note: null, state: 'none' };
        const prev = seen.get(key);
        seen.delete(key);
        seen.set(key, { to: to > from ? to : 0, len: messages.length });
        while (seen.size > maxSeen) seen.delete(seen.keys().next().value);
        if (!(to > from)) return { note: null, state: 'none' };

        const meta = loadMeta(key);
        const { file } = files(key);
        let state = 'steady';
        if (!meta) {
          const advanced = prev && prev.to > 0 && prev.to !== to;
          // The same conversation one step earlier, not a short side request (title, probe).
          const first = prev && prev.to === 0 && prev.len <= messages.length && prev.len * 2 >= messages.length;
          if (!advanced && !first) {
            stats.waiting++;
            return { note: null, state: 'waiting' };
          }
          writeAll(key, messages, from, to);
          state = 'started';
        } else if (meta.from !== from || to < meta.to || meta.head !== shapeOf(messages[from])
          || meta.last !== shapeOf(messages[meta.to - 1])) {
          writeAll(key, messages, from, to);
          state = 'rewritten';
        } else if (to > meta.to) {
          fs.appendFileSync(file, rangeText(messages, meta.to, to));
          saveMeta(key, { ...meta, to, last: shapeOf(messages[to - 1]) });
          state = 'appended';
        }
        stats[state]++;
        return { note: transcriptNote(file), state };
      } catch {
        stats.errors++;
        // Keep an already-started pointer byte-stable even when the disk write failed.
        const started = metas.get(key);
        return { note: started ? transcriptNote(files(key).file) : null, state: 'error' };
      }
    },
  };
}
