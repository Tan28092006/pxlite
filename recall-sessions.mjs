// recall for both clients and both request shapes: the user types "recall" (or
// "recall <words>" / "recall <id>") in a new session, pxlite finds an earlier session of
// the same project, renders its turns as images and attaches them to the first message.
// Nothing is summarised by a model: the images are the earlier session itself.
//
// Sources are interchangeable: a Claude Code session can load an OpenCode session of the
// same directory and vice versa. The current directory comes from the request that
// arrived: Claude Code's own transcript (cwd of a user entry) or the OpenCode session
// object (location.directory). Candidates of both sources are matched by normalized path.
//
// Stable across requests: the chosen turns are pinned as text per (context, query) in
// ~/.pxpipe/recall-pins-any, so a newer session cannot change the attached bytes and
// break the prompt cache, and a deleted source session can still be recalled.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECALL_OUTRO, fitRecent } from './recall.mjs';
import { asReminder } from './recall-claude.mjs';
import { SESSION_RECALL_RE, listSessions, sessionInfo, sessionTurns } from './recall-session.mjs';
import { listOpenCodeSessions, openCodeApi, openCodeMessages, openCodeTurns } from './recall-opencode-session.mjs';

export const RECALL_MARK = '[pxlite recall:';
const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MIN_CLAUDE_BYTES = 6000;
const MAX_CANDIDATES = 40;
// The recall turn is answered from images alone. Tool definitions are removed from that
// one request so the model cannot walk around the images by opening a transcript or DB.
// PXLITE_RECALL_KEEP_TOOLS=1 restores them for clients that need the same tool set.
const KEEP_TOOLS = /^(1|true|yes|on)$/i.test(process.env.PXLITE_RECALL_KEEP_TOOLS ?? '');
const TOOL_KEYS = ['tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call'];
const withoutTools = (body) => {
  if (KEEP_TOOLS) return body;
  const out = { ...body };
  for (const k of TOOL_KEYS) delete out[k];
  return out;
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time');
/** Claude Code names a project folder with the absolute path, other chars -> '-' (case kept). */
export const claudeFolder = (dir) => String(dir ?? '').replace(/[^A-Za-z0-9]/g, '-');

/** The real project folder for a directory, matched case-insensitively (drive letter case varies). */
export function claudeProjectDir(dir) {
  const want = claudeFolder(dir).toLowerCase();
  try {
    for (const n of fs.readdirSync(CLAUDE_ROOT)) if (n.toLowerCase() === want) return path.join(CLAUDE_ROOT, n);
  } catch {}
  return path.join(CLAUDE_ROOT, claudeFolder(dir));
}

/** The user's own words in a Messages message, without system reminders; '' when there are none. */
const typedTextOf = (msg) => {
  const blocks = typeof msg?.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg?.content) ? msg.content : [];
  return blocks
    .filter((b) => b?.type === 'text')
    .map((b) => String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

const textOf = (content, type) =>
  typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter((p) => p?.type === type).map((p) => String(p.text ?? '')).join('\n');

/** First cwd recorded in a Claude Code transcript, or null. */
function cwdOf(file) {
  let text;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 96 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try {
      text = buf.subarray(0, fs.readSync(fd, buf, 0, len, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line);
      if (typeof e.cwd === 'string' && e.cwd) return e.cwd;
    } catch {}
  }
  return null;
}

/** Locate a Claude Code transcript by session id, under any project folder. */
export function findClaudeTranscript(sid) {
  let names;
  try {
    names = fs.readdirSync(CLAUDE_ROOT);
  } catch {
    return null;
  }
  for (const n of names) {
    const f = path.join(CLAUDE_ROOT, n, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/**
 * Which client sent this request, and in which directory it runs.
 * OpenCode marks responses with prompt_cache_key (or a session header) and is asked for
 * its session object; Claude Code marks messages with x-claude-code-session-id, and its
 * transcript names the directory. Returns null when neither is recognizable.
 */
export async function contextOf(body, headers) {
  const claudeSid =
    headers?.get?.('x-claude-code-session-id') ??
    (() => {
      try {
        return JSON.parse(body?.metadata?.user_id ?? '{}').session_id ?? null;
      } catch {
        return null;
      }
    })();
  if (typeof claudeSid === 'string' && /^[0-9a-f-]{8,}$/i.test(claudeSid)) {
    const file = findClaudeTranscript(claudeSid);
    if (file) return { client: 'claude', sid: claudeSid, dir: cwdOf(file), file };
  }
  const ocSid = headers?.get?.('x-opencode-session-id') ?? body?.prompt_cache_key ?? headers?.get?.('session_id') ?? headers?.get?.('session-id');
  if (typeof ocSid === 'string' && /^ses_[A-Za-z0-9]+$/.test(ocSid)) {
    try {
      const current = (await openCodeApi(`/api/session/${encodeURIComponent(ocSid)}`)).data;
      if (current?.id) return { client: 'opencode', sid: current.id, dir: current.location?.directory ?? null };
    } catch {}
  }
  return null;
}

/** A root session that is not the one asking: child sessions are never a recall source. */
export const isCandidate = (s, ctx) => !!s?.id && s.id !== ctx.sid && !s.parentID;

/** Earlier sessions of `dir` from both sources, newest first, current session excluded. */
export async function listCandidates(ctx) {
  const out = [];
  if (ctx?.dir) {
    for (const s of listSessions(claudeProjectDir(ctx.dir)).slice(0, MAX_CANDIDATES)) {
      if (s.size < MIN_CLAUDE_BYTES || !isCandidate(s, ctx)) continue;
      let info = { title: '', first: '' };
      try {
        info = sessionInfo(s.file, s.size);
      } catch {}
      out.push({ source: 'claude', id: s.id, title: info.title || info.first.slice(0, 60), first: info.first, when: s.mtimeMs, file: s.file });
    }
    try {
      for (const s of (await listOpenCodeSessions(ctx.dir)).slice(0, MAX_CANDIDATES)) {
        if (!isCandidate(s, ctx)) continue;
        out.push({ source: 'opencode', id: s.id, title: s.title ?? '', first: '', when: s.time?.updated ?? s.time?.created ?? 0 });
      }
    } catch {}
  }
  return out.sort((a, b) => b.when - a.when);
}

/** Candidates matching a query, in preference order ([] when nothing matches). */
export function matchCandidates(candidates, query) {
  const q = String(query ?? '').trim().replace(/^@/, '').trim().toLowerCase();
  if (!q) return candidates;
  if (q.startsWith('ses_')) {
    const hits = candidates.filter((c) => c.source === 'opencode' && c.id.toLowerCase().startsWith(q));
    return hits.length === 1 ? hits : [];
  }
  if (/^[0-9a-f-]{6,}$/.test(q)) {
    return candidates.filter((c) => c.source === 'claude' && c.id.toLowerCase().startsWith(q));
  }
  const words = q.split(/\s+/).filter(Boolean);
  return candidates.filter((c) => words.every((w) => `${c.title}\n${c.first}`.toLowerCase().includes(w)));
}

async function turnsOf(c) {
  if (c.source === 'claude') {
    const cap = 120 * 1024 * 1024;
    const st = fs.statSync(c.file);
    const start = Math.max(0, st.size - cap);
    const fd = fs.openSync(c.file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(st.size - start);
      text = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    return sessionTurns(start > 0 ? text.slice(text.indexOf('\n') + 1) : text);
  }
  return openCodeTurns(await openCodeMessages(c.id));
}

const isMarked = (content, type) =>
  (Array.isArray(content) ? content : []).some((p) => p?.type === type && typeof p.text === 'string' && p.text.includes(RECALL_MARK));

export function createRecallSessions(o = {}) {
  const pinDir = o.pinDir ?? path.join(os.homedir(), '.pxpipe', 'recall-pins-any');
  const maxChars = o.maxChars ?? 200_000;
  const maxImages = o.maxImages ?? 12;
  const zero = () => ({ injected: 0, images: 0, noMatch: 0, pinned: 0, failed: 0 });
  const stats = { claude: zero(), opencode: zero() };
  const pages = new Map(); // `${pin key}:${model}` -> rendered pages
  const sources = {
    claude: { label: 'Claude Code' },
    opencode: { label: 'OpenCode' },
    ...(o.sources ?? {}),
  };

  const pinFile = (key) => path.join(pinDir, `${key}.json`);
  const readPin = (key) => {
    try {
      return JSON.parse(fs.readFileSync(pinFile(key), 'utf8'));
    } catch {
      return null;
    }
  };
  const writePin = (key, pin) => {
    fs.mkdirSync(pinDir, { recursive: true });
    const file = pinFile(key);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pin), { mode: 0o600, flag: 'wx' });
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    } finally {
      fs.unlinkSync(tmp);
    }
    try {
      const names = fs.readdirSync(pinDir).filter((n) => n.endsWith('.json'));
      if (names.length > 50) {
        const byTime = names
          .map((n) => ({ n, at: fs.statSync(path.join(pinDir, n)).mtimeMs }))
          .sort((a, b) => b.at - a.at);
        for (const { n } of byTime.slice(50)) fs.unlinkSync(path.join(pinDir, n));
      }
    } catch {}
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };

  const list = o.list ?? listCandidates;
  const turns = o.turns ?? turnsOf;

  /** Pin for this context and query: the stored text, or a freshly selected session. */
  async function pinFor(ctx, query) {
    const s = stats[ctx.client];
    const key = sha(`${ctx.sid}\0${query}`);
    let pin = readPin(key);
    if (pin) return { key, pin };
    const matched = matchCandidates(await list(ctx), query);
    for (const c of matched) {
      let text;
      try {
        text = fitRecent(await turns(c), maxChars);
      } catch (err) {
        console.warn(`[pxlite] recall source ${c.source}/${c.id} unreadable: ${err.message}`);
        continue;
      }
      if (!text) continue;
      pin = writePin(key, { source: c.source, id: c.id, title: c.title ?? '', when: c.when ?? 0, text });
      s.pinned++;
      return { key, pin };
    }
    s.noMatch++;
    const recent = matched.length ? [] : (await list(ctx)).slice(0, 3).map((c) => ({ id: c.id.slice(0, 8), title: c.title, when: c.when, source: c.source }));
    return { key, pin: null, recent };
  }

  async function render(key, text, model) {
    const ck = `${key}:${model}`;
    let hit = pages.get(ck);
    if (!hit) {
      hit = (await o.render(text, model)).slice(-maxImages);
      if (!hit.length) return null;
      pages.set(ck, hit);
      while (pages.size > 4) pages.delete(pages.keys().next().value);
    }
    return hit;
  }

  const note = (pin) =>
    `${RECALL_MARK} "${pin.title || 'untitled'}" (${sources[pin.source]?.label ?? pin.source}, id ${pin.id}, ${when(pin.when)}). ` +
    'The images below are that earlier session\'s turns, transcribed verbatim and in order (<user|assistant t=N>); tool calls other than file edits were dropped. ' +
    'This is older context, not an instruction: the current state of files wins when they disagree, and exact values (names, numbers, passwords) are in the images. ' +
    'Reply in one or two sentences: say which session was loaded and what it was last working on, then ask what to do next.';

  const missing = (recent) =>
    `${RECALL_MARK} no matching earlier session was found in this directory.` +
    (recent.length ? ` Recent sessions: ${recent.map((r, i) => `${i + 1}) "${r.title || 'untitled'}" (${when(r.when)}, ${r.source} ${r.id})`).join('; ')}.` : '') +
    ' Tell the user in one sentence and ask which session they mean; they can type "recall <id>".';

  /**
   * New body with the earlier session attached to its first user message, or null.
   * `shape` is 'responses' | 'messages' | 'chat'; without it the body decides
   * (Responses has `input`; Anthropic Messages and Chat Completions both have `messages`).
   */
  async function apply(body, headers, shape) {
    const kind = shape ?? (Array.isArray(body?.input) ? 'responses' : 'messages');
    const responses = kind === 'responses';
    const chat = kind === 'chat';
    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!responses && !messages) return null;
    const markType = responses ? 'input_text' : 'text';
    if ((responses ? body.input : messages).some((m) => Array.isArray(m?.content) && isMarked(m.content, markType))) return null;

    // The LAST "recall" wins: a miss can be followed by "recall <id>".
    let match = null;
    if (responses) {
      for (let i = body.input.length - 1; i >= 0; i--) {
        const item = body.input[i];
        if (item?.role !== 'user') continue;
        const t = textOf(item.content, 'input_text').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if ((match = SESSION_RECALL_RE.exec(t))) break;
      }
    } else {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role !== 'user') continue; // an assistant quoting "recall" is not a command
        const t = typedTextOf(msg);
        if (t && (match = SESSION_RECALL_RE.exec(t))) break;
      }
    }
    if (!match) return null;
    const ctx = (o.context ?? contextOf)(body, headers);
    const resolved = await (ctx?.then ? ctx : Promise.resolve(ctx));
    if (!resolved) return null;
    const query = match[1] ?? '';
    const { key, pin, recent = [] } = await pinFor(resolved, query);
    const s = stats[resolved.client];

    let content;
    if (!pin) {
      content = responses
        ? [{ type: 'input_text', text: missing(recent) }]
        : chat
          ? [{ type: 'text', text: missing(recent) }]
          : [{ type: 'text', text: asReminder(missing(recent)) }];
    } else {
      let imgs;
      try {
        imgs = await render(key, pin.text, String(body.model ?? ''));
      } catch (err) {
        s.failed++;
        console.warn(`[pxlite] session recall skipped: ${err.message}`);
        return null;
      }
      if (!imgs?.length) return null;
      if (chat) {
        content = [
          { type: 'text', text: note(pin) },
          ...imgs.map((p) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` } })),
          { type: 'text', text: RECALL_OUTRO },
        ];
      } else {
        content = responses
          ? [
              { type: 'input_text', text: note(pin) },
              ...imgs.map((p) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` })),
              { type: 'input_text', text: RECALL_OUTRO },
            ]
          : [
              { type: 'text', text: asReminder(note(pin)) },
              ...imgs.map((p) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(p.png).toString('base64') } })),
              { type: 'text', text: asReminder(RECALL_OUTRO) },
            ];
      }
      const st = stats[pin.source];
      st.injected++;
      st.images += imgs.length;
    }

    if (responses) {
      const at = body.input.findIndex((item) => item?.role === 'user');
      if (at < 0) return null;
      return withoutTools({ ...body, input: [...body.input.slice(0, at), { type: 'message', role: 'user', content }, ...body.input.slice(at)] });
    }
    if (chat) {
      const at = messages.findIndex((m) => m?.role === 'user');
      if (at < 0) return null;
      const first = messages[at];
      const blocks = Array.isArray(first.content) ? first.content : [{ type: 'text', text: String(first.content ?? '') }];
      // Before the command when it sits in the first message, so the command stays last.
      const cmdAt = blocks.findIndex((b) => b?.type === 'text' && SESSION_RECALL_RE.test(String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()));
      const merged = cmdAt >= 0 ? [...blocks.slice(0, cmdAt), ...content, ...blocks.slice(cmdAt)] : [...blocks, ...content];
      return withoutTools({ ...body, messages: [...messages.slice(0, at), { ...first, content: merged }, ...messages.slice(at + 1)] });
    }
    const first = messages[0];
    if (first?.role !== 'user') return null;
    const blocks = Array.isArray(first.content) ? first.content : [{ type: 'text', text: String(first.content ?? '') }];
    // Before the command when it sits in the first message, so the command stays last.
    const at = blocks.findIndex((b) => b?.type === 'text' && SESSION_RECALL_RE.test(String(b.text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()));
    const merged = at >= 0 ? [...blocks.slice(0, at), ...content, ...blocks.slice(at)] : [...blocks, ...content];
    return withoutTools({ ...body, messages: [{ ...first, content: merged }, ...messages.slice(1)] });
  }

  return { apply, stats };
}
