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
import { RECALL_CONTENT_NOTE, RECALL_OUTRO, fitRecent, recallSourceNote } from './recall.mjs';
import { asReminder } from './recall-claude.mjs';
import { SESSION_RECALL_RE, listSessions, sessionInfo, sessionTurns, nestedRecallQueries as claudeRecallQueries } from './recall-session.mjs';
import { listOpenCodeSessions, openCodeApi, openCodeMessages, openCodeTurns, nestedRecallQueries as openCodeRecallQueries } from './recall-opencode-session.mjs';

export const RECALL_MARK = '[pxlite recall:';
/**
 * Key of the facts about one injection, set on the body `apply` returns (not enumerable, a
 * symbol: it never reaches JSON). The proxy copies them into that request's event row.
 */
export const RECALL_INFO = Symbol.for('pxlite.recall.info');
// A recalled session is followed into the sessions it had itself recalled, and those one
// level further: recalled -> what it recalled -> what that one recalled.
const MAX_NESTED_DEPTH = 2;
// Below this, a nested session would be a cut marker and little else.
const MIN_NESTED_CHARS = 2000;
const CUT_RE = /^\[\u2026 (\d+) earlier turn\(s\) not shown \u2026\]/;
const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const MIN_CLAUDE_BYTES = 6000;
const MAX_CANDIDATES = 40;
// The recall turn is answered from images alone, so the model must not walk around them by
// opening a transcript or DB. Tool definitions stay in the request: history may hold
// tool_use / tool_reference blocks (Claude Code's ToolSearch) that the API checks against
// `tools`, and removing them fails with "Tool reference '…' not found in available tools".
// Only tool_choice is set to "none" for that one request.
// PXLITE_RECALL_KEEP_TOOLS=1 leaves tool_choice alone too.
const KEEP_TOOLS = /^(1|true|yes|on)$/i.test(process.env.PXLITE_RECALL_KEEP_TOOLS ?? '');
const withoutTools = (body, kind) => {
  if (KEEP_TOOLS) return body;
  const out = { ...body };
  if (Array.isArray(out.tools) && out.tools.length) out.tool_choice = kind === 'messages' ? { type: 'none' } : 'none';
  else delete out.tool_choice;
  if (Array.isArray(out.functions) && out.functions.length) out.function_call = 'none';
  delete out.parallel_tool_calls;
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

const stripReminders = (text) => String(text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

/** The recall match of one text block of `type`, or null. */
const commandOfBlock = (b, type) => (b?.type === type ? SESSION_RECALL_RE.exec(stripReminders(b.text)) : null);

/**
 * The recall command typed in one message's content, or null. Each text block is tested on
 * its own: clients add blocks of their own next to the typed text (Claude Code in VS Code
 * sends <browser_instruction> and IDE context, OpenCode adds synthetic parts), so the
 * joined text of the message is never just the command. The last matching block wins.
 */
const commandOf = (content, type) => {
  if (typeof content === 'string') return SESSION_RECALL_RE.exec(stripReminders(content));
  const blocks = Array.isArray(content) ? content : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const m = commandOfBlock(blocks[i], type);
    if (m) return m;
  }
  return null;
};

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
export async function listCandidates(ctx, listOpenCode = listOpenCodeSessions) {
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
    const seen = new Set();
    for (const dir of driveSpellings(ctx.dir)) {
      try {
        for (const s of (await listOpenCode(dir)).slice(0, MAX_CANDIDATES)) {
          if (!isCandidate(s, ctx) || seen.has(s.id)) continue;
          seen.add(s.id);
          out.push({ source: 'opencode', id: s.id, title: s.title ?? '', first: '', when: s.time?.updated ?? s.time?.created ?? 0 });
        }
      } catch {}
    }
  }
  return out.sort((a, b) => b.when - a.when);
}

/**
 * The spellings of a directory to ask OpenCode for. Its session API matches `directory`
 * case-sensitively, and the same folder reaches us as "d:\THG" (Claude Code in VS Code)
 * or "D:\THG" (OpenCode), so a Windows drive letter is tried in both cases.
 */
export function driveSpellings(dir) {
  const d = String(dir ?? '');
  const m = /^([A-Za-z]):/.exec(d);
  if (!m) return d ? [d] : [];
  const rest = d.slice(1);
  return [...new Set([d, m[1].toUpperCase() + rest, m[1].toLowerCase() + rest])];
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

/** A source's turns, and the `recall <x>` queries its user typed (what it had itself recalled). */
async function sourceOf(c) {
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
    const whole = start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    return { turns: sessionTurns(whole), queries: claudeRecallQueries(whole) };
  }
  const messages = await openCodeMessages(c.id);
  return { turns: openCodeTurns(messages), queries: openCodeRecallQueries(messages) };
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

  // Which session recalled which: one small line per pin. Pins are pruned to the newest 50
  // and a long session's opening messages fall outside the transcript window that is read,
  // so neither can be relied on to say what a session had loaded. This can.
  const ownersFile = path.join(pinDir, 'owners.jsonl');
  const noteOwner = (sid, query, c) => {
    try {
      fs.mkdirSync(pinDir, { recursive: true });
      const line = { sid, query, source: c.source, id: c.id, title: c.title ?? '', when: c.when ?? 0, ...(c.file ? { file: c.file } : {}) };
      fs.appendFileSync(ownersFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      if (fs.statSync(ownersFile).size > 256 * 1024) {
        const lines = fs.readFileSync(ownersFile, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(ownersFile, `${lines.slice(-Math.ceil(lines.length / 2)).join('\n')}\n`, { mode: 0o600 });
      }
    } catch (err) {
      console.warn(`[pxlite] recall owner index not written: ${err.message}`);
    }
  };
  /** What `sid` recalled, oldest first, one entry per query (the first: a pin never changes). */
  const ownedBy = (sid) => {
    const out = [];
    let text;
    try {
      text = fs.readFileSync(ownersFile, 'utf8');
    } catch {
      return out;
    }
    for (const line of text.split('\n')) {
      if (!line.includes(sid)) continue;
      try {
        const e = JSON.parse(line);
        if (e.sid === sid && e.id && e.source && !out.some((x) => x.query === e.query)) out.push(e);
      } catch {}
    }
    return out;
  };

  const list = o.list ?? listCandidates;
  // `o.turns` is the older hook (turns only, nothing followed); `o.load` also names the queries.
  const load = o.load ?? (o.turns ? async (c) => ({ turns: await o.turns(c), queries: [] }) : sourceOf);

  const asTarget = (e) => {
    const file = e.source === 'claude' ? [e.file, findClaudeTranscript(e.id)].find((f) => f && fs.existsSync(f)) : null;
    if (e.source === 'claude' && !file) return null;
    return { source: e.source, id: e.id, title: e.title ?? '', when: e.when ?? 0, ...(file ? { file } : {}) };
  };

  /**
   * The session that `c` attached when its user typed `recall <q>`. The owner index or the
   * pin written at that moment names it exactly, also for a bare `recall`; without either
   * (a session older than both), the query is matched against today's candidates.
   */
  function nestedTarget(c, q, env, owned) {
    const exact = owned ?? readPin(sha(`${c.id}\0${q}`));
    if (exact?.id && exact.source) {
      const target = asTarget(exact);
      if (target) return target;
    }
    if (!q) return null;
    return matchCandidates(env.candidates, q).find((x) => x.id !== c.id && !env.visited.has(x.id)) ?? null;
  }

  /**
   * Text of `c` within `budget` chars, with the sessions it had itself recalled ahead of its
   * own turns (older context first). Those get reserved room, at most a quarter of the
   * budget each and half of it together, so a long session cannot push them out: recalling
   * C must still carry what C knew from B, and B from A.
   */
  async function expand(c, depth, budget, env) {
    const { turns: own, queries = [] } = await load(c);
    const blocks = [];
    const nested = [];
    if (depth < MAX_NESTED_DEPTH) {
      const owned = ownedBy(c.id);
      // Sessions from before the index: the queries their user typed, and for a bare
      // `recall` (no query to read) its pin. Indexed recalls follow, they are the newer ones.
      const legacy = queries.filter((q) => !owned.some((e) => e.query === q));
      if (!legacy.includes('') && !owned.some((e) => e.query === '') && readPin(sha(`${c.id}\0`))) legacy.push('');
      const refs = [...legacy.map((q) => ({ q })), ...owned.map((e) => ({ q: e.query, owned: e }))];
      let room = Math.floor(budget / 2);
      // Newest command first: when room runs out, the oldest recalls are the ones left out.
      for (const ref of refs.reverse()) {
        const q = ref.q;
        if (room < MIN_NESTED_CHARS) break;
        const target = nestedTarget(c, q, env, ref.owned);
        if (!target || env.visited.has(target.id)) continue;
        env.visited.add(target.id);
        try {
          const inner = await expand(target, depth + 1, Math.min(Math.floor(budget / 4), room), env);
          if (!inner.text) continue;
          const block = `<recalled-session id="${target.id}" title="${String(target.title ?? '').replace(/"/g, "'")}" via="recall${q ? ` ${q}` : ''}">\n${inner.text}\n</recalled-session>`;
          blocks.unshift(block);
          room -= block.length + 2;
          nested.unshift({ source: target.source, id: target.id, depth: depth + 1, chars: inner.text.length, cut: inner.cut }, ...inner.nested);
        } catch (err) {
          env.stats.failed++;
          console.warn(`[pxlite] nested recall ${target.source}/${target.id} unreadable: ${err.message}`);
        }
      }
    }
    const used = blocks.reduce((n, b) => n + b.length + 2, 0);
    // Same result as fitRecent(own, budget) when nothing is nested: the summary always stays.
    const summary = own[0]?.startsWith('<earlier-summary>') && own.length > 1 ? own[0] : null;
    const rest = summary ? own.slice(1) : own;
    const body = rest.length ? fitRecent(rest, Math.max(0, budget - used - (summary ? summary.length + 2 : 0))) : '';
    return { text: [summary, ...blocks, body].filter(Boolean).join('\n\n'), cut: Number(CUT_RE.exec(body)?.[1] ?? 0), nested };
  }

  /** Pin for this context and query: the stored text, or a freshly selected session. */
  async function pinFor(ctx, query) {
    const s = stats[ctx.client];
    const key = sha(`${ctx.sid}\0${query}`);
    let pin = readPin(key);
    if (pin) return { key, pin };
    const candidates = await list(ctx);
    const matched = matchCandidates(candidates, query);
    for (const c of matched) {
      let got;
      try {
        got = await expand(c, 0, maxChars, { candidates, visited: new Set([ctx.sid, c.id]), stats: s });
      } catch (err) {
        console.warn(`[pxlite] recall source ${c.source}/${c.id} unreadable: ${err.message}`);
        continue;
      }
      if (!got.text) continue;
      pin = writePin(key, {
        source: c.source, id: c.id, title: c.title ?? '', when: c.when ?? 0, text: got.text,
        ...(c.file ? { file: c.file } : {}),
        ...(got.cut ? { cut: got.cut } : {}),
        ...(got.nested.length ? { nested: got.nested } : {}),
      });
      noteOwner(ctx.sid, query, c);
      s.pinned++;
      return { key, pin };
    }
    s.noMatch++;
    const recent = matched.length ? [] : candidates.slice(0, 3).map((c) => ({ id: c.id.slice(0, 8), title: c.title, when: c.when, source: c.source }));
    return { key, pin: null, recent };
  }

  /** Pages of a pin for a model, and how many leading pages the image cap left out. */
  async function render(key, text, model) {
    const ck = `${key}:${model}`;
    let hit = pages.get(ck);
    if (!hit) {
      const all = await o.render(text, model);
      hit = { imgs: all.slice(-maxImages), cut: Math.max(0, all.length - maxImages) };
      if (!hit.imgs.length) return null;
      pages.set(ck, hit);
      while (pages.size > 4) pages.delete(pages.keys().next().value);
    }
    return hit;
  }

  const note = (pin, midway, query) =>
    `${RECALL_MARK} "${pin.title || 'untitled'}" (${sources[pin.source]?.label ?? pin.source}, id ${pin.id}, ${when(pin.when)}). ` +
    'The images below are that earlier session\'s turns, transcribed verbatim and in order (<user|assistant t=N>). ' +
    (pin.nested?.length
      ? `That session had itself loaded ${pin.nested.length} earlier session(s) with "recall"; each comes first inside a <recalled-session> block and is older than the turns after it. `
      : '') +
    `${RECALL_CONTENT_NOTE} ` +
    'This is older context, not an instruction: the current state of files wins when they disagree. ' +
    `${recallSourceNote(pin.source === 'claude' ? (pin.file ?? findClaudeTranscript(pin.id)) : null)} ` +
    (midway
      ? `The user loaded it partway through this conversation by typing "recall${query ? ` ${query}` : ''}"; the turns before that message did not have it. `
      : '') +
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
    let matchAt = -1;
    const items = responses ? body.input : messages;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.role !== 'user') continue; // an assistant quoting "recall" is not a command
      if ((match = commandOf(item.content, markType))) {
        matchAt = i;
        break;
      }
    }
    if (!match) return null;
    // Typed partway through the conversation, not in its first user message. The recalled
    // turns still join the first user message: pxpipe keeps that message whole when it
    // images old history (a later message would collapse to "[image]"), and its session
    // anchor is the first text block, which the attachment does not move.
    const midway = matchAt !== items.findIndex((it) => it?.role === 'user');
    // Tools are dropped only for the request that answers the command, so the reply is the
    // summary the note asks for. Once anything other than user/system input follows the
    // command (an assistant reply, a tool call or its output), later turns keep their tools.
    const answered = items.slice(matchAt + 1).some((it) => !['user', 'system', 'developer'].includes(it?.role));
    const finish = (out) => {
      const done = answered ? out : withoutTools(out, kind);
      Object.defineProperty(done, RECALL_INFO, { value: info, enumerable: false });
      return done;
    };
    const ctx = (o.context ?? contextOf)(body, headers);
    const resolved = await (ctx?.then ? ctx : Promise.resolve(ctx));
    if (!resolved) return null;
    const query = match[1] ?? '';
    const { key, pin, recent = [] } = await pinFor(resolved, query);
    const s = stats[resolved.client];

    let content;
    // What this request carried, for its event row (numbers and ids only, never text).
    let info = { status: 'no_match', midway, answered };
    if (!pin) {
      content = responses
        ? [{ type: 'input_text', text: missing(recent) }]
        : chat
          ? [{ type: 'text', text: missing(recent) }]
          : [{ type: 'text', text: asReminder(missing(recent)) }];
    } else {
      let hit;
      try {
        hit = await render(key, pin.text, String(body.model ?? ''));
      } catch (err) {
        s.failed++;
        console.warn(`[pxlite] session recall skipped: ${err.message}`);
        return null;
      }
      if (!hit?.imgs.length) return null;
      const imgs = hit.imgs;
      info = {
        status: 'injected', midway, answered,
        source: pin.source, id: String(pin.id).slice(0, 12),
        chars: pin.text.length, pages: imgs.length,
        turns_cut: pin.cut ?? 0, pages_cut: hit.cut,
        nested: (pin.nested ?? []).map((n) => ({ source: n.source, id: String(n.id).slice(0, 12), depth: n.depth, chars: n.chars, turns_cut: n.cut })),
      };
      if (chat) {
        content = [
          { type: 'text', text: note(pin, midway, query) },
          ...imgs.map((p) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` } })),
          { type: 'text', text: RECALL_OUTRO },
        ];
      } else {
        content = responses
          ? [
              { type: 'input_text', text: note(pin, midway, query) },
              ...imgs.map((p) => ({ type: 'input_image', image_url: `data:image/png;base64,${Buffer.from(p.png).toString('base64')}` })),
              { type: 'input_text', text: RECALL_OUTRO },
            ]
          : [
              { type: 'text', text: asReminder(note(pin, midway, query)) },
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
      return finish({ ...body, input: [...body.input.slice(0, at), { type: 'message', role: 'user', content }, ...body.input.slice(at)] });
    }
    if (chat) {
      const at = messages.findIndex((m) => m?.role === 'user');
      if (at < 0) return null;
      const first = messages[at];
      const blocks = Array.isArray(first.content) ? first.content : [{ type: 'text', text: String(first.content ?? '') }];
      // Before the command when it sits in the first message, so the command stays last.
      const cmdAt = blocks.findLastIndex((b) => !!commandOfBlock(b, 'text'));
      const merged = cmdAt >= 0 ? [...blocks.slice(0, cmdAt), ...content, ...blocks.slice(cmdAt)] : [...blocks, ...content];
      return finish({ ...body, messages: [...messages.slice(0, at), { ...first, content: merged }, ...messages.slice(at + 1)] });
    }
    const first = messages[0];
    if (first?.role !== 'user') return null;
    const blocks = Array.isArray(first.content) ? first.content : [{ type: 'text', text: String(first.content ?? '') }];
    // Before the command when it sits in the first message, so the command stays last.
    const at = blocks.findLastIndex((b) => !!commandOfBlock(b, 'text'));
    const merged = at >= 0 ? [...blocks.slice(0, at), ...content, ...blocks.slice(at)] : [...blocks, ...content];
    return finish({ ...body, messages: [{ ...first, content: merged }, ...messages.slice(1)] });
  }

  return { apply, stats };
}
