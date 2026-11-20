// Collapse old, successful tool results of Bash / Edit / Write in Anthropic Messages requests.
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
const COLLAPSIBLE = new Set(['bash', 'edit', 'write', 'multiedit', 'notebookedit']);
const ERR_RE = /error|failed|failure|traceback|exception|exit code [1-9]|\bFAIL\b|not found|denied|cannot|can't|fatal|panic/i;
const MARKER = '[pxlite: older output collapsed';

export function ttlMsOf(ttl) {
  return ttl === '5m' ? 5 * 60_000 : 60 * 60_000;
}

function resultText(block) {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((p) => p && p.type === 'text')) return c.map((p) => p.text ?? '').join('\n');
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
  minSave = 500,
  minGainChars = 40_000,
  headChars = 300,
  tailChars = 150,
  writeInputKeep = 600,
  ttlMs = 60 * 60_000,
  maxSessions = 500,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map(); // key -> { boundary, lastTs }

  // Collapsible blocks inside messages[from, to): [{ block, kind, saved }]
  function scan(messages, from, to) {
    const names = new Map();
    for (let i = 0; i < to; i++) {
      const m = messages[i];
      if (m?.role === 'assistant' && Array.isArray(m.content)) {
        for (const b of m.content) if (b?.type === 'tool_use' && b.id) names.set(b.id, { name: String(b.name ?? '').toLowerCase(), block: b });
      }
    }
    const found = [];
    for (let i = from; i < to; i++) {
      const m = messages[i];
      if (!Array.isArray(m?.content)) continue;
      for (const b of m.content) {
        if (b?.type === 'tool_result' && !b.is_error) {
          const info = names.get(b.tool_use_id);
          if (!info || !COLLAPSIBLE.has(info.name)) continue;
          const text = resultText(b);
          if (text === null || text.startsWith(MARKER) || text.includes(MARKER) || ERR_RE.test(text)) continue;
          const saved = text.length - (headChars + tailChars + 80);
          if (saved >= minSave) found.push({ block: b, text, saved });
        } else if (b?.type === 'tool_use' && b.name?.toLowerCase() === 'write' && typeof b.input?.content === 'string' && b.input.content.length > writeInputKeep + minSave) {
          found.push({ block: b, write: true, saved: b.input.content.length - writeInputKeep });
        }
      }
    }
    return found;
  }

  function collapseUpTo(messages, boundary) {
    let count = 0;
    for (const f of scan(messages, 0, boundary)) {
      if (f.write) {
        const c = f.block.input.content;
        f.block.input = { ...f.block.input, content: `${c.slice(0, writeInputKeep)}\n${MARKER}, ${c.length - writeInputKeep} chars of file content dropped]` };
      } else {
        f.block.content = stub(f.text, headChars, tailChars);
      }
      count++;
    }
    return count;
  }

  /** Mutates body in place; returns how many blocks were collapsed. */
  function apply(body, { sessionKey } = {}) {
    const messages = body?.messages;
    if (!sessionKey || !Array.isArray(messages)) return 0;
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
