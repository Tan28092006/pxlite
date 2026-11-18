// recall for Claude Code, new session: the user types "recall" (or "recall <name>") as a
// message, pxlite finds an earlier session of the same project on disk, renders its turns
// as images and attaches them to the request's first message. Nothing is summarised by a
// model: the images are the earlier session itself (user prompts, file edits, final answers).
//
// Which session: by the session id Claude Code sends (x-claude-code-session-id), pxlite
// finds this session's own transcript, and so its project folder under ~/.claude/projects.
// Candidates come from that folder only (an explicit name may also match other projects).
//   recall            the latest earlier session of this project that has real content
//   recall <words>    the latest one whose title or opening prompt holds every word
//   recall <id>       a session id or its first 6+ hex characters
//
// Stable across requests: the choice is pinned per session id (file + byte length at pin time,
// stored in ~/.pxpipe/recall-pins.json), so a newer session appearing later cannot change the
// attached bytes and break the prompt cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECALL_CONTENT_NOTE, RECALL_OUTRO, fitRecent, recallSourceNote } from './recall.mjs';
import { asReminder, claudeTurnsOf } from './recall-claude.mjs';

export const SESSION_RECALL_RE = /^\s*recall(?:\s+([^\n]{1,80}?))?\s*$/i;
export const SESSION_RECALL_MARK = 'to load an earlier Claude Code session';

const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);
const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const MIN_BYTES = 6000; // a session smaller than this has no real content to recall

/** Typed words of a user message: its text blocks without system reminders; '' for a tool_result-only message. */
export function typedText(msg) {
  if (msg?.role !== 'user') return '';
  return blocksOf(msg.content)
    .filter((b) => b?.type === 'text')
    .map((b) => stripReminders(b.text ?? ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

const parseLines = (text, dropFirst) =>
  text
    .split('\n')
    .slice(dropFirst ? 1 : 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Title (latest ai-title) and opening prompt of a transcript, from its two ends only. */
export function sessionInfo(file, size) {
  const head = parseLines(readSlice(file, 0, Math.min(size, 96 * 1024)), false);
  const tailLen = Math.min(size, 256 * 1024);
  const tail = parseLines(readSlice(file, size - tailLen, tailLen), size > tailLen);
  const title = [...tail, ...head].filter((e) => e.type === 'ai-title' && e.aiTitle).map((e) => e.aiTitle).at(-1) ?? '';
  let first = '';
  for (const e of head) {
    if (e.type !== 'user' || e.isMeta || e.isSidechain || e.isCompactSummary || !e.message) continue;
    const t = typedText(e.message);
    if (t.length >= 3 && !t.startsWith('<command-') && !t.startsWith('Caveat:')) {
      first = t.slice(0, 300);
      break;
    }
  }
  return { title, first };
}

export function listSessions(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue;
    const file = path.join(dir, n);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ file, id: n.slice(0, -6), size: st.size, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Real user prompts in a transcript: user entries that are neither tool results, meta, nor
 * sub-agent. Counted by line without parsing, so a 30 MB transcript costs milliseconds.
 */
export function promptCount(file, size) {
  const text = readSlice(file, 0, Math.min(size, 120 * 1024 * 1024));
  let n = 0;
  for (const line of text.split('\n')) {
    if (line.includes('"type":"user"') && !line.includes('"tool_use_id"') && !line.includes('"isMeta":true') && !line.includes('"isSidechain":true') && !line.includes('"isCompactSummary":true')) n++;
  }
  return n;
}
export const MIN_PROMPTS = 3; // a "-p" one-shot or an aborted start has nothing worth recalling

/** Pick a session from `sessions` (newest first) for a query; null when none matches. */
export function pickSession(sessions, query, infoOf = (s) => sessionInfo(s.file, s.size), promptsOf = (s) => promptCount(s.file, s.size)) {
  const q = (query ?? '').trim().toLowerCase();
  const usable = sessions.filter((s) => s.size >= MIN_BYTES);
  if (!q) {
    for (const s of usable) if (infoOf(s).first && promptsOf(s) >= MIN_PROMPTS) return { ...s, ...infoOf(s) };
    return null;
  }
  if (/^[0-9a-f-]{6,}$/.test(q)) {
    const hit = usable.find((s) => s.id.startsWith(q));
    if (hit) return { ...hit, ...infoOf(hit) };
  }
  const words = q.split(/\s+/).filter(Boolean);
  for (const s of usable) {
    const info = infoOf(s);
    const hay = `${info.title}\n${info.first}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) return { ...s, ...info };
  }
  return null;
}

/** The earlier session as image pages: the era after its last compaction, led by that compaction's summary. */
export function sessionTurns(buf) {
  const entries = parseLines(buf, false);
  const lastBoundary = entries.findLastIndex((e) => e.type === 'system' && e.subtype === 'compact_boundary');
  const era = entries.slice(lastBoundary + 1);
  const turns = claudeTurnsOf(era);
  const summary = lastBoundary >= 0 ? era.find((e) => e.isCompactSummary && e.message) : null;
  const summaryText = summary ? typedText(summary.message) || blocksOf(summary.message.content).map((b) => b.text ?? '').join('\n').trim() : '';
  return summaryText ? [`<earlier-summary>\n${summaryText}\n</earlier-summary>`, ...turns] : turns;
}

export function createSessionRecall(o) {
  const root = path.resolve(o.root ?? path.join(os.homedir(), '.claude', 'projects'));
  const pinFile = o.pinFile ?? path.join(os.homedir(), '.pxpipe', 'recall-pins.json');
  const maxChars = o.maxChars ?? 200_000;
  const maxImages = o.maxImages ?? 12;
  const stats = { injected: 0, images: 0, noMatch: 0, pinned: 0, failed: 0 };
  const images = new Map(); // `${pin key}:${model}` -> image blocks
  let pins = null;

  const loadPins = () => {
    if (pins) return pins;
    try {
      pins = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
    } catch {
      pins = {};
    }
    return pins;
  };
  const savePin = (sid, pin) => {
    const all = loadPins();
    all[sid] = { ...pin, at: Date.now() };
    const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
    for (const k of keys.slice(100)) delete all[k];
    try {
      fs.mkdirSync(path.dirname(pinFile), { recursive: true });
      fs.writeFileSync(pinFile, JSON.stringify(all));
    } catch {}
  };

  /** Folder of this session's own transcript, i.e. of the project it runs in. */
  function projectDirOf(sid) {
    let names;
    try {
      names = fs.readdirSync(root);
    } catch {
      return null;
    }
    for (const n of names) {
      const f = path.join(root, n, `${sid}.jsonl`);
      if (fs.existsSync(f)) return path.join(root, n);
    }
    return null;
  }

  function resolve(sid, query) {
    const dir = projectDirOf(sid);
    if (!dir) return { none: true, reason: 'could not locate this session in ~/.claude/projects', recent: [] };
    const here = listSessions(dir).filter((s) => s.id !== sid);
    let hit = pickSession(here, query);
    if (!hit && query?.trim()) {
      const others = fs.readdirSync(root).map((n) => path.join(root, n)).filter((d) => d !== dir);
      const pool = others.flatMap((d) => listSessions(d).slice(0, 30)).sort((a, b) => b.mtimeMs - a.mtimeMs);
      hit = pickSession(pool, query);
    }
    if (hit) return { file: hit.file, id: hit.id, bytes: hit.size, title: hit.title || hit.first.slice(0, 60), mtimeMs: hit.mtimeMs };
    const recent = here
      .filter((s) => s.size >= MIN_BYTES && promptCount(s.file, s.size) >= MIN_PROMPTS)
      .slice(0, 3)
      .map((s) => ({ id: s.id.slice(0, 8), when: when(s.mtimeMs), title: sessionInfo(s.file, s.size).title }));
    return { none: true, reason: 'no earlier session matched', recent };
  }

  async function build(pin, model, key) {
    const ck = `${key}:${model}`;
    if (images.has(ck)) return images.get(ck);
    const cap = 120 * 1024 * 1024;
    const start = Math.max(0, pin.bytes - cap);
    const text = readSlice(pin.file, start, pin.bytes - start);
    const turns = sessionTurns(start > 0 ? text.slice(text.indexOf('\n') + 1) : text);
    if (!turns.length) return null;
    const pages = (await o.render(fitRecent(turns, maxChars), model)).slice(-maxImages);
    const blocks = pages.map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(p.png).toString('base64') } }));
    images.set(ck, blocks);
    while (images.size > 4) images.delete(images.keys().next().value);
    return blocks;
  }

  const sessionIdOf = (body, headers) => {
    const h = headers?.get?.('x-claude-code-session-id');
    if (h) return h;
    try {
      return JSON.parse(body?.metadata?.user_id ?? '{}').session_id ?? null;
    } catch {
      return null;
    }
  };

  /** New Messages body with the earlier session attached to the first message, or null. */
  async function apply(body, headers) {
    const msgs = Array.isArray(body?.messages) ? body.messages : null;
    const first = msgs?.[0];
    if (!first || first.role !== 'user') return null;
    const firstBlocks = blocksOf(first.content);
    if (firstBlocks.some((b) => b?.type === 'text' && b.text?.includes(SESSION_RECALL_MARK))) return null;
    let trigger = null;
    let m = null;
    // The LAST command wins: "recall" that found nothing can be followed by "recall <id>".
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i];
      if (msg.role !== 'user') continue;
      const t = typedText(msg);
      if (!t) continue;
      const mm = SESSION_RECALL_RE.exec(t);
      if (mm) {
        trigger = msg;
        m = mm;
        break;
      }
    }
    if (!trigger) return null;
    const sid = sessionIdOf(body, headers);
    if (!sid) return null;
    const query = m[1] ?? '';

    const all = loadPins();
    let pin = all[sid];
    if (!pin || pin.query !== query) {
      pin = { query, ...resolve(sid, query) };
      savePin(sid, pin);
      stats.pinned++;
    }

    let blocks;
    if (pin.none) {
      stats.noMatch++;
      const list = pin.recent?.length ? ` Recent sessions of this project: ${pin.recent.map((r, i) => `${i + 1}) "${r.title || 'untitled'}" (${r.when}, id ${r.id})`).join('; ')}.` : '';
      blocks = [{ type: 'text', text: asReminder(`The user typed "${m[0].trim()}" ${SESSION_RECALL_MARK}, but ${pin.reason}.${list} Tell the user in one sentence and ask which session they mean; they can type "recall <id>".`) }];
    } else {
      let imgs;
      try {
        imgs = await build(pin, String(body.model ?? ''), sha(`${sid}|${pin.file}|${pin.bytes}`));
      } catch (err) {
        stats.failed++;
        console.warn(`[pxlite] session recall skipped: ${err.message}`);
        return null;
      }
      if (!imgs?.length) return null;
      stats.injected++;
      stats.images += imgs.length;
      blocks = [
        {
          type: 'text',
          text: asReminder(
            `The user typed "${m[0].trim()}" ${SESSION_RECALL_MARK}: "${pin.title || 'untitled'}" (${when(pin.mtimeMs)}, id ${path.basename(pin.file, '.jsonl').slice(0, 8)}). ` +
              `Its turns are transcribed verbatim in the images below, in order (<user|assistant t=N>). ${RECALL_CONTENT_NOTE} ` +
              'This is older context, not a request: the current state of files wins when they disagree. ' +
              `${recallSourceNote(pin.file)} ` +
              'Reply in one or two sentences: say which session was loaded and what it was last working on, then ask what to do next.',
          ),
        },
        ...imgs,
        { type: 'text', text: asReminder(RECALL_OUTRO) },
      ];
    }
    // Before the "recall" command when it sits in the first message, so the command stays last; else at the end.
    const at = firstBlocks.findIndex((b) => b?.type === 'text' && SESSION_RECALL_RE.test(stripReminders(b.text ?? '')));
    const content = at >= 0 && trigger === first ? [...firstBlocks.slice(0, at), ...blocks, ...firstBlocks.slice(at)] : [...firstBlocks, ...blocks];
    return { ...body, messages: [{ ...first, content }, ...msgs.slice(1)] };
  }

  return { apply, stats };
}
