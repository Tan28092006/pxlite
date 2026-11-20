// node scripts/collapse-sim.mjs [--projects <dir>] [--min-msgs 100] [--max-files 80]
//
// Research, read-only, no API calls. Replays real Claude Code transcripts as a stream of requests
// (one request per assistant message; its input = every message before it) and prices the cache:
//   cost = 0.1 * cache_read_tokens + W * cache_write_tokens      (input price = 1.0)
// W = 2.0 for the 1h TTL, 1.25 for the 5m TTL.
//
// Policy "collapse old tool results" (candidate for tool_result dropping in normal sessions):
//   * only successful Bash / Edit / Write / MultiEdit results are collapsible; Read, Grep, Glob,
//     Web*, browse, Task/subagent, MCP and anything that looks like an error are always kept
//   * the newest T messages are never collapsed
//   * the collapse boundary B moves in CHUNKS of K messages (so the prefix only changes once per K)
//   * when B moves, the first changed message invalidates the cache from there to the end
//     (everything after it is rewritten at W instead of read at 0.1)
//   * if the cache already expired (gap > TTL) the whole prefix is rewritten anyway, so the boundary
//     is advanced for free to (n - T)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const PROJECTS = opt('projects', path.join(os.homedir(), '.claude', 'projects'));
const MIN_MSGS = Number(opt('min-msgs', 100));
const MAX_FILES = Number(opt('max-files', 80));
const CPT = 3.3;
const IMG_TOK = 1500;
const STUB_TOK = 120; // head of the output + marker line
const MIN_SAVE = 200; // do not bother collapsing a block that saves less than this
const COLLAPSIBLE = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ERR_RE = /error|failed|failure|traceback|exception|exit code [1-9]|\bFAIL\b|not found|denied|cannot|can't|fatal|panic/i;

function* walk(dir, depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ents) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 5) yield* walk(p, depth + 1);
    else if (d.isFile() && p.endsWith('.jsonl')) yield p;
  }
}

const textLen = (c) => typeof c === 'string' ? c.length
  : Array.isArray(c) ? c.reduce((a, p) => a + (p?.type === 'text' ? (p.text || '').length : p?.type === 'image' ? 0 : 0), 0) : 0;
const imgCount = (c) => Array.isArray(c) ? c.filter((p) => p?.type === 'image').length : 0;
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text || '').join('\n') : '';

/** -> { msgs: [{role, ts, full, coll}], stats } */
function load(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const toolName = new Map();
  const msgs = [];
  const stats = { byTool: {}, keptErr: 0, collapsibleTok: 0, totalTok: 0 };
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message) continue;
    const role = e.message.role || e.type;
    const content = e.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
    let full = 0, saved = 0;
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') full += (b.text || '').length / CPT;
      else if (b.type === 'image') full += IMG_TOK;
      else if (b.type === 'tool_use') { toolName.set(b.id, b.name); full += (JSON.stringify(b.input || {}).length + 40) / CPT; }
      else if (b.type === 'tool_result') {
        const name = toolName.get(b.tool_use_id) || '?';
        const t = textOf(b.content);
        const tok = t.length / CPT + imgCount(b.content) * IMG_TOK + 10;
        full += tok;
        const s = (stats.byTool[name] ||= { n: 0, tok: 0 });
        s.n++; s.tok += tok;
        if (COLLAPSIBLE.has(name)) {
          if (b.is_error || ERR_RE.test(t)) { stats.keptErr += tok; }
          else if (tok - STUB_TOK >= MIN_SAVE) saved += tok - STUB_TOK;
        }
      }
      // thinking blocks are dropped from later requests
    }
    const last = msgs[msgs.length - 1];
    const sameMsg = last && last.role === role && (role === 'user' || (e.message.id && last.id === e.message.id) || role === 'assistant');
    if (sameMsg) { last.full += full; last.saved += saved; if (ts) last.ts = ts; }
    else msgs.push({ role, id: e.message.id, ts, full, saved });
  }
  for (const m of msgs) { m.coll = m.full - m.saved; stats.totalTok += m.full; stats.collapsibleTok += m.saved; }
  return { msgs, stats };
}

/** Price one session. K = chunk (0 = policy off). */
function price(msgs, { K, T, W, TTL = 3600e3 }) {
  const n = msgs.length;
  const pf = new Float64Array(n + 1), pc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pf[i + 1] = pf[i] + msgs[i].full; pc[i + 1] = pc[i] + msgs[i].coll; }
  const nextC = new Int32Array(n + 1); nextC[n] = n;
  for (let i = n - 1; i >= 0; i--) nextC[i] = msgs[i].saved > 0 ? i : nextC[i + 1];
  const tot = (B, m) => { const b = Math.min(B, m); return pc[b] + (pf[m] - pf[b]); };
  let B = 0, prevN = 0, prevTs = 0, cost = 0, reads = 0, writes = 0, jumps = 0, expiries = 0, reqs = 0;
  for (let j = 1; j < n; j++) {
    if (msgs[j].role !== 'assistant') continue;
    const m = j; // input = messages [0..m)
    const ts = msgs[j].ts || 0;
    const expired = prevN === 0 || (prevTs && ts && ts - prevTs > TTL);
    reqs++;
    const B0 = B;
    if (K > 0) {
      if (expired) { if (m - T > B) { B = m - T; } }
      else if (m - T - B >= K) { B = B + K * Math.floor((m - T - B) / K); }
    }
    let common = 0;
    if (!expired) {
      const fc = nextC[Math.min(B0, n)] < Math.min(B, prevN) ? nextC[B0] : prevN; // first changed idx or all
      common = tot(B, Math.min(fc, prevN));
      if (fc < prevN) jumps++;
    } else expiries++;
    const total = tot(B, m);
    const rd = Math.min(common, total), wr = total - rd;
    cost += 0.1 * rd + W * wr; reads += rd; writes += wr;
    prevN = m; prevTs = ts;
  }
  return { cost, reads, writes, jumps, expiries, reqs };
}

const files = [];
for (const f of walk(PROJECTS)) { try { const s = fs.statSync(f); if (s.size > 300e3) files.push({ f, s: s.size }); } catch {} }
files.sort((a, b) => b.s - a.s);
const sessions = [];
const agg = {};
for (const { f } of files.slice(0, MAX_FILES * 2)) {
  const d = load(f);
  if (!d || d.msgs.length < MIN_MSGS) continue;
  sessions.push({ f, ...d });
  for (const [k, v] of Object.entries(d.stats.byTool)) { const a = (agg[k] ||= { n: 0, tok: 0 }); a.n += v.n; a.tok += v.tok; }
  if (sessions.length >= MAX_FILES) break;
}
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const totTok = sessions.reduce((a, s) => a + s.stats.totalTok, 0);
const colTok = sessions.reduce((a, s) => a + s.stats.collapsibleTok, 0);
console.log(`sessions=${sessions.length} (>=${MIN_MSGS} msgs), messages=${fmt(sessions.reduce((a, s) => a + s.msgs.length, 0))}`);
console.log(`message tokens (sum over sessions): ${fmt(totTok)}; collapsible (ok Bash/Edit/Write, not error): ${fmt(colTok)} = ${(100 * colTok / totTok).toFixed(1)}%`);
console.log('tool_result tokens by tool (top 10):');
for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].tok - a[1].tok).slice(0, 10)) console.log(`  ${k.padEnd(14)} n=${String(v.n).padStart(6)}  tok=${fmt(v.tok).padStart(12)}  ${(100 * v.tok / totTok).toFixed(1)}%`);

for (const W of [2.0, 1.25]) {
  console.log(`\n=== W=${W} (${W === 2 ? '1h' : '5m'} cache write price; TTL ${W === 2 ? '1h' : '5m'}) ===`);
  const TTL = W === 2 ? 3600e3 : 300e3;
  const base = sessions.map((s) => price(s.msgs, { K: 0, T: 0, W, TTL }));
  const baseCost = base.reduce((a, r) => a + r.cost, 0);
  console.log(`baseline cost=${fmt(baseCost)} reqs=${fmt(base.reduce((a, r) => a + r.reqs, 0))} expiries=${fmt(base.reduce((a, r) => a + r.expiries, 0))}`);
  console.log('T   K     saving  better/worse(sessions)  jumps  worst-session');
  for (const T of [10, 30]) {
    for (const K of [10, 20, 30, 50, 75, 100, 150, 200, 300]) {
      let c = 0, better = 0, worse = 0, jumps = 0, worst = 0;
      sessions.forEach((s, i) => {
        const r = price(s.msgs, { K, T, W, TTL });
        c += r.cost; jumps += r.jumps;
        const d = (base[i].cost - r.cost) / base[i].cost;
        if (d > 0.002) better++; else if (d < -0.002) worse++;
        worst = Math.min(worst, d);
      });
      console.log(`${String(T).padEnd(3)} ${String(K).padEnd(5)} ${(100 * (baseCost - c) / baseCost).toFixed(2).padStart(6)}%  ${String(better).padStart(3)}/${String(worse).padEnd(3)}                 ${String(jumps).padStart(5)}  ${(100 * worst).toFixed(1)}%`);
    }
  }
}
