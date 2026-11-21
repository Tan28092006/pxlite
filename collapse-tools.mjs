// Collapse old, successful tool results of Bash / Edit / Write in Anthropic Messages, OpenAI Chat\n// Completions and OpenAI Responses requests (OpenCode, Codex tool names included).
//
// Rules (researched with scripts/collapse-sim.mjs on real transcripts, no API calls):
//   * only Bash / Edit / Write / MultiEdit / NotebookEdit results are collapsible; Read, Grep,
//     Glob, Web*, browse, subagents, MCP and graph tools are never touched
//   * anything that looks like an error / failed test is kept whole
//   * the newest `keepTail` messages are never collapsed (an agent in the middle of a task still sees them)
//   * a collapsed result keeps its head and last line, so the agent still knows what happened
//   * the collapse boundary only moves in two cases, so the cached prefix stays byte-identical:
//       1. the cache already expired (gap since the previous request > TTL): the prefix is rewritten
//          anyway, so the boundary jumps to (n - keepTail) for free
//       2. the boundary lags by a whole chunk (`chunk` messages) AND the newly collapsible text is big
//          enough to pay for rewriting the cache (`minGainChars`)
//     Between moves the collapsed set is a pure function of the boundary, so requests keep cache hits.
const COLLAPSIBLE = new Set(['bash', 'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'shell', 'shell_command', 'exec_command']);
const ERR_RE = /error|failed|failure|traceback|exception|exit code [1-9]|\bFAIL\b|not found|denied|cannot|can't|fatal|panic/i;
const MARKER = '[pxlite: older output collapsed';

export function ttlMsOf(ttl) {
  return ttl === '5m' ? 5 * 60_000 : 60 * 60_000;
}

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length && c.every((p) => p && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'))) return c.map((p) => p.text ?? '').join('\n');
  return null; // images or unknown shape: leave alone
}

function stub(text, headChars, tailChars) {
  const head = text.slice(0, headChars);
  const lastLine = text.trimEnd().split('\n').pop().slice(-tailChars);
  const dropped = text.length - head.length;
  return `${head}\n${MARKER}, ${dropped} chars dropped. last line: ${lastLine}]`;
}

export function createToolCollapse({
  chunk = 100,
  keepTail = 30,
  minSave = 200,
  minGainChars = 40_000,
  headChars = 300,
  tailChars = 150,
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
    const names = new Map();
    for (let i = 0; i < to; i++) {
      const m = items[i];
      if (!m) continue;
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b?.type === 'tool_use' && b.id) names.set(b.id, String(b.name ?? '').toLowerCase());
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) names.set(tc.id, String(tc.function?.name ?? '').toLowerCase());
      }
      if ((m.type === 'function_call' || m.type === 'custom_tool_call') && m.call_id) names.set(m.call_id, String(m.name ?? '').toLowerCase());
    }
    const found = [];
    const addResult = (id, isErr, read, write) => {
      if (isErr || !COLLAPSIBLE.has(names.get(id))) return;
      const text = read();
      if (text === null || text.includes(MARKER) || ERR_RE.test(text)) return;
      const saved = text.length - (headChars + tailChars + 80);
      if (saved >= minSave) found.push({ saved, run: () => write(stub(text, headChars, tailChars)) });
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
