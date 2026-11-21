// Collapse old tool results in Anthropic Messages, OpenAI Chat Completions and OpenAI Responses
// requests (OpenCode, Codex tool names included).
//
// Rules (researched with scripts/collapse-sim.mjs and the OpenCode db on real transcripts, no API calls):
//   * Bash / PowerShell / Edit / Write / MultiEdit / NotebookEdit / patch results are collapsible when they
//     succeeded; web*, browse, subagents, MCP, graph tools, Grep and Glob are never touched
//   * a success result that looks failed (error words in the first/last 300 chars, or a non-zero exit code)
//     is kept whole; only the head and the tail are scanned, because file contents and match lines are full of
//     the word "error"
//   * Read is collapsible only when the agent no longer needs it: the same file was read again (same range, or a
//     full read) or edited/written/patched later, inside the already-frozen prefix. Reads nobody superseded stay
//     whole
//   * shell rg / grep results are reduced to a `path: line,line,...` index (offsets kept, match text dropped),
//     so the agent still knows where to `Read` with an offset
//   * the newest `keepTail` messages are never collapsed (an agent in the middle of a task still sees them)
//   * a collapsed result keeps its head and last line, so the agent still knows what happened
//   * the collapse boundary only moves in two cases, so the cached prefix stays byte-identical:
//       1. the cache already expired (gap since the previous request > TTL): the prefix is rewritten
//          anyway, so the boundary jumps to (n - keepTail) for free
//       2. the boundary lags by a whole chunk (`chunk` messages) AND the newly collapsible text is big
//          enough to pay for rewriting the cache (`minGainChars`)
//     Between moves the collapsed set is a pure function of the boundary (every decision, including
//     "was this Read superseded", looks only at messages before the boundary), so requests keep cache hits.
const SHELL = new Set(['bash', 'shell', 'shell_command', 'exec_command', 'powershell', 'pwsh']);
const COLLAPSIBLE = new Set(['bash', 'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'shell', 'shell_command', 'exec_command', 'powershell', 'pwsh']);
const EDITS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch']);
const ERR_RE = /error|failed|failure|traceback|exception|exit code:? *[1-9]|\bFAIL\b|not found|denied|cannot|can't|fatal|panic/i;
const GREP_CMD_RE = /(?:^|&&|;|\|\|)\s*(?:rg|grep|egrep|git\s+grep|findstr|Select-String)\b/i;
const MARKER = '[pxlite: older output collapsed';
const GREP_MAX_CHARS = 1500;
const GREP_MAX_LINES_PER_FILE = 20;

export function ttlMsOf(ttl) {
  return ttl === '5m' ? 5 * 60_000 : 60 * 60_000;
}

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((p) => p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))) return c.map((p) => p.text ?? '').join('\n');
  return null; // images or unknown shape: leave alone
}

/** Errors / failed tests live at the ends of an output; scanning the middle only finds the word in file contents. */
export function looksFailed(text) {
  if (text.length <= 600) return ERR_RE.test(text);
  return ERR_RE.test(text.slice(0, 300)) || ERR_RE.test(text.slice(-300));
}

function stub(text, headChars, tailChars) {
  const head = text.slice(0, headChars);
  const lastLine = text.trimEnd().split('\n').pop().slice(-tailChars);
  const dropped = text.length - head.length;
  return `${head}\n${MARKER}, ${dropped} chars dropped. last line: ${lastLine}]`;
}

const LINE_RE = /^((?:[A-Za-z]:[\\/])?[^:\n]+?):(\d+)[:-]/; // path:12:text  (rg -n, grep -n, findstr /n, Select-String)
const BARE_RE = /^((?:[A-Za-z]:[\\/])?[^:\n]*[./\\][^:\n]*):(?!\d+[:-])/; // path:text (grep -r without -n)
const HEAD_RE = /^(?:[A-Za-z]:[\\/])?[^:\n]*[./\\][^:\n]*$/; // rg --heading file line
const NUM_RE = /^(\d+)[:-]/;

/**
 * rg / grep output -> `path: 12,40,88` index. Returns null when the output does not look like
 * file:line matches (then the normal head/last-line stub is used).
 */
export function condenseGrep(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 3) return null;
  const files = new Map();
  let matched = 0;
  let heading = null;
  const add = (path, line) => {
    let f = files.get(path);
    if (!f) files.set(path, (f = { lines: [], n: 0 }));
    f.n++;
    if (line !== null) f.lines.push(line);
    matched++;
  };
  for (const l of lines) {
    let m = LINE_RE.exec(l);
    if (m) { add(m[1], Number(m[2])); continue; }
    m = heading ? NUM_RE.exec(l) : null;
    if (m) { add(heading, Number(m[1])); continue; }
    if (HEAD_RE.test(l.trim()) && !/\s{2,}/.test(l)) { heading = l.trim(); continue; }
    m = BARE_RE.exec(l);
    if (m) { add(m[1], null); continue; }
  }
  if (!files.size || matched < lines.length * 0.5) return null;
  const rows = [];
  for (const [path, f] of files) {
    const nums = [...new Set(f.lines)].sort((a, b) => a - b);
    const shown = nums.slice(0, GREP_MAX_LINES_PER_FILE).join(',');
    const more = nums.length > GREP_MAX_LINES_PER_FILE ? `,+${nums.length - GREP_MAX_LINES_PER_FILE} more` : '';
    rows.push(nums.length ? `${path}: ${shown}${more}` : `${path}: ${f.n} matches`);
  }
  let body = '';
  let shownFiles = 0;
  for (const r of rows) {
    if (body.length + r.length + 1 > GREP_MAX_CHARS) break;
    body += `${r}\n`;
    shownFiles++;
  }
  const extra = rows.length > shownFiles ? `, +${rows.length - shownFiles} more files` : '';
  return `${MARKER}, grep output reduced to a file:line index (${matched} matches in ${files.size} files${extra}; match text dropped, Read the file at that offset or re-run the search to see it)]\n${body.trimEnd()}`;
}

function parseArgs(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object') return o;
    } catch {
      /* raw string input (custom tools such as apply_patch) */
    }
    return { _raw: v };
  }
  return {};
}

const normPath = (p) => String(p).trim().replace(/\\/g, '/').toLowerCase();
const pathOf = (a) => {
  const p = a.file_path ?? a.filePath ?? a.path ?? a.notebook_path ?? a.file;
  return typeof p === 'string' && p ? normPath(p) : null;
};
const rangeSig = (a) => `${a.offset ?? ''}:${a.limit ?? ''}`;
function patchPaths(a) {
  const t = a._raw ?? a.patchText ?? a.patch ?? a.input;
  if (typeof t !== 'string') return [];
  return [...t.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\r]+)/g)].map((m) => normPath(m[1]));
}

export function createToolCollapse({
  chunk = 100,
  keepTail = 30,
  minSave = 100,
  minGainChars = 40_000,
  headChars = 150,
  tailChars = 80,
  writeInputKeep = 600,
  ttlMs = 60 * 60_000,
  maxSessions = 500,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map(); // key -> { boundary, lastTs }

  // Collapsible results inside items[from, to): [{ saved, run() }]. `items` is body.messages
  // (Anthropic Messages, or OpenAI Chat Completions) or body.input (OpenAI Responses). The
  // three wire shapes are disjoint, so one pass recognises whichever blocks are present.
  function scan(items, from, to) {
    const calls = new Map(); // call id -> { name, seq, path, sig, cmd }
    const touches = new Map(); // path -> [{ seq, sig, edit }] of later read / edit / write calls
    let seq = 0;
    const register = (id, name, rawArgs) => {
      if (!id) return;
      const n = String(name ?? '').toLowerCase();
      const a = parseArgs(rawArgs);
      const c = { name: n, seq: seq++, path: pathOf(a), sig: rangeSig(a), cmd: typeof (a.command ?? a.cmd) === 'string' ? (a.command ?? a.cmd) : '' };
      calls.set(id, c);
      const touch = (p, edit) => {
        if (!p) return;
        if (!touches.has(p)) touches.set(p, []);
        touches.get(p).push({ seq: c.seq, sig: c.sig, edit });
      };
      if (n === 'read') touch(c.path, false);
      else if (EDITS.has(n)) {
        touch(c.path, true);
        if (n === 'apply_patch' || n === 'patch') for (const p of patchPaths(a)) touch(p, true);
      }
    };
    for (let i = 0; i < to; i++) {
      const m = items[i];
      if (!m) continue;
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b?.type === 'tool_use') register(b.id, b.name, b.input);
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) register(tc.id, tc.function?.name, tc.function?.arguments);
      }
      if ((m.type === 'function_call' || m.type === 'custom_tool_call') && m.call_id) register(m.call_id, m.name, m.arguments ?? m.input);
    }
    // A Read is dead weight once a later read of the same range (or a full read) or any edit of that file exists.
    const superseded = (c) => !!c.path && (touches.get(c.path) ?? []).some((t) => t.seq > c.seq && (t.edit || t.sig === c.sig || t.sig === ':'));
    const found = [];
    const addResult = (id, isErr, read, write) => {
      const c = calls.get(id);
      if (isErr || !c) return;
      const isRead = c.name === 'read';
      const isGrep = SHELL.has(c.name) && GREP_CMD_RE.test(c.cmd);
      if (!isRead && !COLLAPSIBLE.has(c.name)) return;
      if (isRead && !superseded(c)) return;
      const text = read();
      if (text === null || text.includes(MARKER)) return;
      if (!isRead && !isGrep && looksFailed(text)) return;
      const rep = (isGrep && condenseGrep(text)) || stub(text, headChars, tailChars);
      const saved = text.length - rep.length;
      if (saved >= minSave) found.push({ saved, run: () => write(rep) });
    };
    const addWrite = (name, content, write) => {
      if (name === 'write' && typeof content === 'string' && content.length > writeInputKeep + minSave) {
        found.push({ saved: content.length - writeInputKeep, run: () => write(`${content.slice(0, writeInputKeep)}\n${MARKER}, ${content.length - writeInputKeep} chars of file content dropped]`) });
      }
    };
    const addWriteArgs = (m) => {
      let args;
      try {
        args = JSON.parse(m.arguments ?? m.function?.arguments);
      } catch {
        return;
      }
      const holder = m.function ?? m;
      addWrite(String(m.name ?? m.function?.name ?? '').toLowerCase(), args?.content, (c) => {
        holder.arguments = JSON.stringify({ ...args, content: c });
      });
    };
    for (let i = from; i < to; i++) {
      const m = items[i];
      if (!m) continue;
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === 'tool_result') addResult(b.tool_use_id, b.is_error, () => textOf(b.content), (s) => { b.content = s; });
          else if (b?.type === 'tool_use') addWrite(String(b.name ?? '').toLowerCase(), b.input?.content, (c) => { b.input = { ...b.input, content: c }; });
        }
      }
      if (m.role === 'tool' && m.tool_call_id) addResult(m.tool_call_id, false, () => textOf(m.content), (s) => { m.content = s; });
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc?.function) addWriteArgs(tc);
      if (m.type === 'function_call_output' || m.type === 'custom_tool_call_output') addResult(m.call_id, false, () => textOf(m.output), (s) => { m.output = s; });
      if (m.type === 'function_call') addWriteArgs(m);
    }
    return found;
  }

  function collapseUpTo(items, boundary) {
    const found = scan(items, 0, boundary);
    for (const f of found) f.run();
    return found.length;
  }

  /** Mutates body in place; returns how many blocks were collapsed. */
  function apply(body, { sessionKey } = {}) {
    const messages = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : null;
    if (!sessionKey || !messages) return 0;
    const n = messages.length;
    const t = now();
    let st = sessions.get(sessionKey);
    const target = Math.max(0, n - keepTail);
    if (!st || n < st.boundary) {
      // First sight of this conversation (or its history shrank, e.g. after compaction): the cache is cold.
      st = { boundary: target, lastTs: t };
    } else if (t - st.lastTs > ttlMs) {
      st.boundary = Math.max(st.boundary, target); // cache expired: moving the boundary is free
    } else if (target - st.boundary >= chunk) {
      const next = st.boundary + Math.floor((target - st.boundary) / chunk) * chunk;
      // the gain of the chunk [boundary, next) with every decision evaluated as of `next`
      const gain = scan(messages, st.boundary, next).reduce((a, f) => a + f.saved, 0);
      if (gain >= minGainChars) st.boundary = next;
    }
    st.lastTs = t;
    sessions.delete(sessionKey);
    sessions.set(sessionKey, st);
    if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    return st.boundary > 0 ? collapseUpTo(messages, st.boundary) : 0;
  }
  return { apply, sessionCount: () => sessions.size };
}
