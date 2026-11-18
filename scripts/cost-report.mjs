#!/usr/bin/env node
// Cache cost report for Claude requests in the pxlite events log (read-only).
//
//   node scripts/cost-report.mjs [--log FILE] [--last N] [--min-create N] [--pairs]
//
// Log path: --log, else $PXPIPE_LOG, else ~/.pxpipe/events.jsonl (same default as pxlite.mjs).
// Only Claude requests with status 200 count. Prints numbers, ids and hashes only, never prompt text.
// Never writes to or rotates the log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Price weights relative to one uncached input token. Single source for every cost in this report.
export const WEIGHTS = { input: 1, cache_read: 0.1, cache_create: 1.25, output: 5 };
const PARTS = [
  ['input', 'input_tokens'],
  ['cache_read', 'cache_read_tokens'],
  ['cache_create', 'cache_create_tokens'],
  ['output', 'output_tokens'],
];
const PAIR_GAP_MS = 5 * 60 * 1000;
const UNKNOWN = 'unknown';
// Fields whose change between two requests of one session can explain a cache write.
export const DIFF_FIELDS = [
  'cache_prefix_sha8',
  'cache_prefix_head_sha8',
  'cache_prefix_marked_sha8',
  'cache_prefix_marker_pos',
  'cache_prefix_system_sha8',
  'cache_prefix_tools_sha8',
  'history_image_sha8',
  'history_freeze_step',
  'image_count',
];

// Bad command line; the CLI exits 2 for it, 1 for other failures.
export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { log: null, last: null, minCreate: 15_000, pairs: false, includeUnknown: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    const int = (min) => {
      const v = Number(value());
      if (!Number.isInteger(v) || v < min) throw new UsageError(`${a} needs an integer >= ${min}`);
      return v;
    };
    if (a === '--log') opts.log = value();
    else if (a === '--last') opts.last = int(1);
    else if (a === '--min-create') opts.minCreate = int(0);
    else if (a === '--pairs') opts.pairs = true;
    else if (a === '--include-unknown') opts.includeUnknown = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  return opts;
}

export function defaultLogPath(env = process.env) {
  return env.PXPIPE_LOG ?? path.join(os.homedir(), '.pxpipe', 'events.jsonl');
}

const num = (v) => (Number.isFinite(v) ? v : 0);
const label = (v) => (v === undefined || v === null || v === '' ? UNKNOWN : String(v));

// Parses JSONL text into Claude 200 events in log order, each annotated with the previous
// event of the same session (`prev`). Bad lines are skipped.
export function loadEvents(text) {
  const events = [];
  const lastBySession = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    if (!String(e.model ?? '').startsWith('claude') || e.status !== 200) continue;
    const session = label(e.session_id);
    const ev = { e, session, prev: lastBySession.get(session) ?? null };
    lastBySession.set(session, ev);
    events.push(ev);
  }
  return events;
}

export function costParts(e) {
  const out = {};
  for (const [part, field] of PARTS) out[part] = num(e[field]) * WEIGHTS[part];
  return out;
}

const pct = (a, b) => (b > 0 ? `${((100 * a) / b).toFixed(1)}%` : '-');
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const gapSec = (ev) => {
  if (!ev.prev) return null;
  const d = Date.parse(ev.e.ts) - Date.parse(ev.prev.e.ts);
  return Number.isFinite(d) ? d / 1000 : null;
};

function table(header, rows) {
  const cells = [header, ...rows].map((r) => r.map(String));
  const w = header.map((_, i) => Math.max(...cells.map((r) => r[i].length)));
  // First column left-aligned, last column unpadded (free text), the rest right-aligned numbers.
  const last = header.length - 1;
  const cell = (c, i) => (i === 0 ? c.padEnd(w[i]) : i === last ? c : c.padStart(w[i]));
  return cells.map((r) => r.map(cell).join('  ').trimEnd()).join('\n');
}

function groupTable(events, keyOf, title) {
  const groups = new Map();
  let grand = 0;
  for (const ev of events) {
    const k = keyOf(ev);
    const g = groups.get(k) ?? { n: 0, input: 0, cache_read: 0, cache_create: 0, output: 0 };
    const c = costParts(ev.e);
    g.n++;
    for (const p of Object.keys(c)) g[p] += c[p];
    groups.set(k, g);
    grand += c.input + c.cache_read + c.cache_create + c.output;
  }
  const rows = [...groups]
    .map(([k, g]) => [k, g, g.input + g.cache_read + g.cache_create + g.output])
    .sort((a, b) => b[2] - a[2])
    .map(([k, g, t]) => [k, g.n, fmt(t), pct(t, grand), pct(g.input, t), pct(g.cache_read, t), pct(g.cache_create, t), pct(g.output, t)]);
  return `## By ${title}\n` + table([title, 'reqs', 'cost', 'share', 'input', 'cache_read', 'cache_create', 'output'], rows);
}

function largeWrites(events, minCreate) {
  const rows = events
    .filter((ev) => num(ev.e.cache_create_tokens) >= minCreate)
    .map((ev) => {
      const g = gapSec(ev);
      const changed = ev.prev
        ? DIFF_FIELDS.filter((f) => JSON.stringify(ev.e[f]) !== JSON.stringify(ev.prev.e[f]))
            .map((f) => `${f}:${ev.prev.e[f] ?? '-'}->${ev.e[f] ?? '-'}`)
            .join(' ') || '(none)'
        : '(first in session)';
      return [ev.e.ts ?? '-', ev.session, label(ev.e.body_kind), label(ev.e.history_reason), fmt(num(ev.e.cache_create_tokens)), fmt(num(ev.e.cache_read_tokens)), g === null ? '-' : g.toFixed(0), changed];
    });
  const head = `## Large cache writes (cache_create_tokens >= ${minCreate}): ${rows.length}\n`;
  if (!rows.length) return head + '(none)';
  return head + table(['ts', 'session', 'body_kind', 'history_reason', 'create', 'read', 'gap_s', 'changed vs previous request in session'], rows);
}

// Consecutive compressed requests (those carrying history_image_sha8) of one session with the same
// history image, less than 5 minutes apart. DONE3 holds when the later request reads what the
// earlier one read plus at least 80 % of what it wrote (SPEC "Quyết định" 2026-11-18).
// Requests without session_id may come from different sessions, so they are only paired with
// includeUnknown (old logs written before T1).
export function findPairs(events, { includeUnknown = false } = {}) {
  const lastCompressed = new Map();
  const pairs = [];
  for (const ev of events) {
    if (!ev.e.history_image_sha8) continue;
    if (!includeUnknown && ev.session === UNKNOWN) continue;
    const before = lastCompressed.get(ev.session);
    lastCompressed.set(ev.session, ev);
    if (!before || before.e.history_image_sha8 !== ev.e.history_image_sha8) continue;
    const gapMs = Date.parse(ev.e.ts) - Date.parse(before.e.ts);
    if (!(gapMs >= 0 && gapMs < PAIR_GAP_MS)) continue;
    const prevCreate = num(before.e.cache_create_tokens);
    const prevRead = num(before.e.cache_read_tokens);
    const read = num(ev.e.cache_read_tokens);
    pairs.push({ before, after: ev, gapMs, prevCreate, prevRead, read, done3: read >= prevRead + 0.8 * prevCreate });
  }
  return pairs;
}

function pairsSection(pairs, includeUnknown) {
  const ok = pairs.filter((p) => p.done3).length;
  const head = `## Compressed pairs (same session, same history_image_sha8, < 5 min): ${pairs.length}, DONE3 met: ${ok}\n` +
    (includeUnknown ? `WARNING: --include-unknown pairs requests without session_id; they may come from different sessions\n` : '') +
    `DONE3: read(after) >= read(before) + 0.8 * create(before)\n`;
  if (!pairs.length) return head + '(none)';
  const rows = pairs.map((p) => [p.after.e.ts ?? '-', p.after.session, p.after.e.history_image_sha8, (p.gapMs / 1000).toFixed(0), fmt(p.prevRead), fmt(p.prevCreate), fmt(p.read), p.done3 ? 'yes' : 'no']);
  return head + table(['ts(after)', 'session', 'history_image_sha8', 'gap_s', 'read(before)', 'create(before)', 'read(after)', 'DONE3'], rows);
}

export function report(events, opts) {
  const sel = opts.last === null ? events : events.slice(-opts.last);
  const total = sel.reduce((s, ev) => s + Object.values(costParts(ev.e)).reduce((a, b) => a + b, 0), 0);
  const out = [
    `# Cache cost report — ${sel.length} Claude requests (status 200)` + (sel.length ? `, ${sel[0].e.ts} .. ${sel[sel.length - 1].e.ts}` : ''),
    `Weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} x${v}`).join(', ')}; cost in input-token units: ${fmt(total)}`,
    groupTable(sel, (ev) => label(ev.e.body_kind), 'body_kind'),
    groupTable(sel, (ev) => label(ev.e.agent_role), 'agent_role'),
    groupTable(sel, (ev) => label(ev.e.history_reason), 'history_reason'),
    groupTable(sel, (ev) => ev.session, 'session_id'),
    largeWrites(sel, opts.minCreate),
  ];
  if (opts.pairs) {
    const inWindow = new Set(sel);
    const includeUnknown = Boolean(opts.includeUnknown);
    out.push(pairsSection(findPairs(events, { includeUnknown }).filter((p) => inWindow.has(p.after)), includeUnknown));
  }
  return out.join('\n\n') + '\n';
}

// Reads the rotated backup (<log>.1.jsonl, written by rotlog.mjs) before the live file, so a
// recent rotation does not cut the window.
export function readLog(file) {
  const backup = file.replace(/(\.jsonl)?$/, '.1.jsonl');
  return [backup, file].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')).join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const file = opts.log ?? defaultLogPath();
    if (!fs.existsSync(file)) throw new Error(`log not found: ${file}`);
    process.stdout.write(report(loadEvents(readLog(file)), opts));
  } catch (err) {
    console.error(`cost-report: ${err.message}`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
