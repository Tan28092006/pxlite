// node scripts/keep-report.mjs [--projects <dir>] [--events <file>] [--min-chars N] [--top N]
//
// Measures what keepSharp (classify.mjs) keeps as text, on REAL data, in REQUEST ORDER:
//  A. Replays Claude Code transcripts (~/.claude/projects/**/*.jsonl) line by line, which is
//     the order the requests were built in. Every tool_result block is classified once, in
//     position, so the tally is per reason, per session third (early/mid/late), and shows how
//     many chars would flip to "imaged" if the limits were looser (threshold sweep).
//  B. Reads the pxlite events log (~/.pxpipe/events.jsonl), groups it by session in ts order and
//     reports kept_sharp per request plus cache-prefix stability between consecutive requests
//     (cache_prefix_sha8 must only grow/stay; a change in the middle of a session breaks cache).
// Read-only. No API calls. analyze() is a pure function of the block text, so a block gets the
// same decision on every request; the report double checks that on a sample.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LIMITS, analyze } from '../classify.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const PROJECTS = opt('projects', path.join(os.homedir(), '.claude', 'projects'));
const EVENTS = opt('events', path.join(os.homedir(), '.pxpipe', 'events.jsonl'));
const MIN_CHARS = Number(opt('min-chars', 500));
const TOP = Number(opt('top', 8));

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '-');
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

function* walk(dir, depth = 0) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory() && depth < 4) yield* walk(p, depth + 1);
    else if (d.isFile() && p.endsWith('.jsonl')) yield p;
  }
}

const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n') : '';

/** tool_result blocks of one session file, in file (= request) order. */
function toolResults(file) {
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  let turn = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'assistant') turn++;
    const content = e.message?.content;
    if (e.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== 'tool_result') continue;
      const text = textOf(b.content);
      if (text.length >= MIN_CHARS) out.push({ text, turn });
    }
  }
  return out;
}

// ---- A: transcripts ---------------------------------------------------------------------
const base = { ...LIMITS };
const setScale = (k) => {
  for (const key of ['digitRatio', 'numericShare', 'hexPerLine', 'jsonKvPerLine', 'rowShare', 'timestampShare', 'windowDigitRatio', 'windowNumericShare']) LIMITS[key] = base[key] * k;
};
const SCALES = [0.8, 1, 1.25, 1.5, 2];

const byReason = new Map(); // reason -> { blocks, chars }
const byThird = [0, 1, 2].map(() => ({ blocks: 0, kept: 0, chars: 0, keptChars: 0 }));
const keptSamples = [];
const sweep = SCALES.map(() => ({ keptChars: 0 }));
let sessions = 0;
let blocks = 0;
let chars = 0;
let unstable = 0;

for (const file of walk(PROJECTS)) {
  const list = toolResults(file);
  if (!list.length) continue;
  sessions++;
  const lastTurn = Math.max(...list.map((b) => b.turn), 1);
  for (const b of list) {
    setScale(1);
    const { reason, signals } = analyze(b.text);
    if (analyze(b.text).reason !== reason) unstable++; // purity check: same text, same answer
    blocks++;
    chars += b.text.length;
    const third = Math.min(2, Math.floor((3 * b.turn) / (lastTurn + 1)));
    const t = byThird[third];
    t.blocks++;
    t.chars += b.text.length;
    if (reason) {
      t.kept++;
      t.keptChars += b.text.length;
      const r = byReason.get(reason) ?? { blocks: 0, chars: 0 };
      r.blocks++;
      r.chars += b.text.length;
      byReason.set(reason, r);
      keptSamples.push({ reason, chars: b.text.length, signals, head: b.text.slice(0, 70).replace(/\s+/g, ' '), file: path.basename(file) });
    }
    SCALES.forEach((k, i) => {
      setScale(k);
      if (analyze(b.text).reason) sweep[i].keptChars += b.text.length;
    });
  }
}
setScale(1);

console.log(`# A. tool_result blocks >= ${MIN_CHARS} chars, replayed in request order`);
console.log(`sessions ${sessions}, blocks ${fmt(blocks)}, chars ${fmt(chars)}, purity violations ${unstable}\n`);

const kept = [...byReason.values()].reduce((a, r) => a + r.chars, 0);
console.log(`kept as text: ${fmt(kept)} chars = ${pct(kept, chars)} of all tool_result chars\n`);
console.log(`${pad('reason', 14)}${rpad('blocks', 8)}${rpad('chars', 12)}${rpad('share of kept', 15)}`);
for (const [reason, r] of [...byReason].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(`${pad(reason, 14)}${rpad(r.blocks, 8)}${rpad(fmt(r.chars), 12)}${rpad(pct(r.chars, kept), 15)}`);
}

console.log(`\nby position in the session (request order):`);
['early', 'middle', 'late'].forEach((name, i) => {
  const t = byThird[i];
  console.log(`  ${pad(name, 7)} blocks ${rpad(t.blocks, 6)}  kept ${rpad(pct(t.kept, t.blocks), 6)} of blocks, ${rpad(pct(t.keptChars, t.chars), 6)} of chars`);
});

console.log(`\nthreshold sweep (all limits x k): chars kept as text`);
SCALES.forEach((k, i) => {
  const moved = sweep[1].keptChars - sweep[i].keptChars;
  console.log(`  x${pad(k, 5)} kept ${rpad(fmt(sweep[i].keptChars), 12)} (${rpad(pct(sweep[i].keptChars, chars), 6)})  ${i === 1 ? 'current' : `${moved >= 0 ? 'imaged' : 'kept'} ${fmt(Math.abs(moved))} chars vs current`}`);
});

console.log(`\nlargest kept blocks:`);
for (const s of keptSamples.sort((a, b) => b.chars - a.chars).slice(0, TOP)) {
  console.log(`  ${rpad(fmt(s.chars), 9)} ${pad(s.reason, 12)} dig ${s.signals.digitRatio.toFixed(2)} num ${s.signals.numericShare.toFixed(2)} | ${s.head}`);
}

// ---- B: events log, per session in ts order ---------------------------------------------
console.log(`\n# B. events log, per session in request order`);
let rows = [];
try {
  rows = fs
    .readFileSync(EVENTS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.status === 200 && typeof e.path === 'string' && e.path.includes('/messages'));
} catch {
  console.log(`(no events log at ${EVENTS})`);
}
const sessionsB = new Map();
for (const e of rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
  const k = e.session_id ?? 'unknown';
  if (!sessionsB.has(k)) sessionsB.set(k, []);
  sessionsB.get(k).push(e);
}
let reqs = 0;
let keptSharp = 0;
let compressedReqs = 0;
let prefixChecked = 0;
let prefixChanged = 0;
let readTok = 0;
let createTok = 0;
const changes = [];
for (const [sid, list] of sessionsB) {
  list.forEach((e, i) => {
    reqs++;
    keptSharp += e.passthrough_reasons?.kept_sharp ?? 0;
    if (e.compressed) compressedReqs++;
    readTok += e.cache_read_tokens ?? 0;
    createTok += e.cache_create_tokens ?? 0;
    const prev = list[i - 1];
    if (prev && e.body_kind !== 'delta' && prev.cache_prefix_sha8 && e.cache_prefix_sha8) {
      prefixChecked++;
      if (prev.cache_prefix_sha8 !== e.cache_prefix_sha8) {
        prefixChanged++;
        changes.push({ sid, step: i, ts: e.ts, hist: e.history_reason, create: e.cache_create_tokens ?? 0 });
      }
    }
  });
}
console.log(`sessions ${sessionsB.size}, requests ${reqs}, compressed ${compressedReqs}, kept_sharp blocks ${keptSharp} (${reqs ? (keptSharp / reqs).toFixed(2) : '-'} per request)`);
console.log(`cache read ${fmt(readTok)} / create ${fmt(createTok)} tokens = read share ${pct(readTok, readTok + createTok)}`);
console.log(`cache prefix changed between consecutive full requests: ${prefixChanged} of ${prefixChecked} (${pct(prefixChanged, prefixChecked)})`);
for (const c of changes.sort((a, b) => b.create - a.create).slice(0, TOP)) {
  console.log(`  ${c.ts} ${String(c.sid).slice(0, 14)} step ${c.step} history=${c.hist ?? '-'} cache_create ${fmt(c.create)}`);
}
