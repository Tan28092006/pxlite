// node --test test-cost-report.mjs
// scripts/cost-report.mjs on a synthetic events log (never the user's real log).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { costParts, defaultLogPath, findPairs, loadEvents, parseArgs, report, simulateTtl, UsageError } from './scripts/cost-report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'scripts', 'cost-report.mjs');
const t0 = Date.parse('2026-11-18T06:00:00.000Z');
const at = (sec) => new Date(t0 + sec * 1000).toISOString();
const ev = (sec, extra) => ({ ts: at(sec), model: 'claude-opus-5-5', status: 200, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_create_tokens: 0, ...extra });
const jsonl = (rows) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

test('costParts applies the declared weights', () => {
  assert.deepEqual(costParts({ input_tokens: 10, cache_read_tokens: 1000, cache_create_tokens: 100, output_tokens: 4 }), {
    input: 10,
    cache_read: 100,
    cache_create: 125,
    output: 20,
  });
  assert.deepEqual(costParts({}), { input: 0, cache_read: 0, cache_create: 0, output: 0 });
});

test('loadEvents keeps only Claude 200 rows, skips bad lines, links previous request per session', () => {
  const events = loadEvents(
    jsonl([
      ev(0, { session_id: 's1' }),
      'not json',
      ev(1, { model: 'gpt-5', session_id: 's1' }),
      ev(2, { status: 429, session_id: 's1' }),
      ev(3, { session_id: 's2' }),
      ev(4, { session_id: 's1' }),
      ev(5, {}),
    ]),
  );
  assert.deepEqual(events.map((e) => [e.e.ts, e.session]), [
    [at(0), 's1'],
    [at(3), 's2'],
    [at(4), 's1'],
    [at(5), 'unknown'],
  ]);
  assert.equal(events[2].prev, events[0]);
  assert.equal(events[1].prev, null);
  assert.equal(events[3].prev, null);
});

test('report groups old rows without session_id/body_kind/agent_role as unknown and prints shares', () => {
  const events = loadEvents(
    jsonl([
      // cost 100 (input) for delta/s1
      ev(0, { session_id: 's1', body_kind: 'delta', agent_role: 'main', input_tokens: 100 }),
      // cost 300 (output 60*5) for an old row without tags
      ev(1, { output_tokens: 60 }),
    ]),
  );
  const out = report(events, { last: null, minCreate: 15000, pairs: false });
  assert.match(out, /2 Claude requests/);
  assert.match(out, /^delta\s+1\s+100\s+25\.0%\s+100\.0%\s+0\.0%\s+0\.0%\s+0\.0%$/m);
  assert.match(out, /^unknown\s+1\s+300\s+75\.0%\s+0\.0%\s+0\.0%\s+0\.0%\s+100\.0%$/m);
  assert.match(out, /## By session_id\nsession_id.*\nunknown\s+1\s+300/);
  assert.match(out, /## By agent_role\nagent_role.*\nunknown\s+1\s+300/);
});

test('--last keeps the newest N requests but diffs against the full history', () => {
  const events = loadEvents(
    jsonl([
      ev(0, { session_id: 's', image_count: 1, history_image_sha8: 'aaaa1111' }),
      ev(30, { session_id: 's', image_count: 2, history_image_sha8: 'bbbb2222', cache_create_tokens: 20000, cache_prefix_marker_pos: 'm3.b1' }),
    ]),
  );
  const out = report(events, { last: 1, minCreate: 15000, pairs: false });
  assert.match(out, /1 Claude requests/);
  assert.match(out, /Large cache writes \(cache_create_tokens >= 15000\): 1/);
  const row = out.split('\n').find((l) => l.startsWith(at(30)));
  assert.match(row, /\b30\s+cache_prefix_marker_pos:-->m3\.b1 history_image_sha8:aaaa1111->bbbb2222 image_count:1->2$/);
  assert.doesNotMatch(row, /history_freeze_step/);
});

test('large writes honour the threshold and mark the first request of a session', () => {
  const events = loadEvents(jsonl([ev(0, { session_id: 'x', cache_create_tokens: 5000 }), ev(10, { session_id: 'y', cache_create_tokens: 5000 })]));
  assert.match(report(events, { last: null, minCreate: 15000, pairs: false }), /: 0\n\(none\)/);
  const out = report(events, { last: null, minCreate: 5000, pairs: false });
  assert.match(out, /: 2\n/);
  assert.match(out, /\(first in session\)/);
});

test('findPairs: consecutive compressed requests, same session and image, under 5 minutes; DONE3 flag', () => {
  const events = loadEvents(
    jsonl([
      // read(before) = 0: the earlier request wrote everything, system part included
      ev(0, { session_id: 'a', history_image_sha8: 'img1', cache_create_tokens: 50000 }),
      ev(1, { session_id: 'a', body_kind: 'delta' }), // not compressed: does not break the pair
      ev(10, { session_id: 'a', history_image_sha8: 'img1', cache_read_tokens: 40000, cache_create_tokens: 1000 }), // 0 + 0.8*50000 → met
      ev(20, { session_id: 'a', history_image_sha8: 'img1', cache_read_tokens: 40799, cache_create_tokens: 1000 }), // needs 40800 → not met
      ev(30, { session_id: 'a', history_image_sha8: 'img1', cache_read_tokens: 41599 }), // 40799 + 800 → met
      ev(30 + 300, { session_id: 'a', history_image_sha8: 'img1' }), // exactly 5 min: not a pair
      ev(400, { session_id: 'b', history_image_sha8: 'img1' }), // other session
      ev(410, { session_id: 'a', history_image_sha8: 'img2' }), // other image
    ]),
  );
  const pairs = findPairs(events);
  assert.deepEqual(
    pairs.map((p) => [p.before.e.ts, p.after.e.ts, p.prevRead, p.prevCreate, p.read, p.done3]),
    [
      [at(0), at(10), 0, 50000, 40000, true],
      [at(10), at(20), 40000, 1000, 40799, false],
      [at(20), at(30), 40799, 1000, 41599, true],
    ],
  );
  const out = report(events, { last: null, minCreate: 15000, pairs: true });
  assert.match(out, /Compressed pairs .*: 3, DONE3 met: 2/);
  assert.match(out, /read\(before\)\s+create\(before\)\s+read\(after\)\s+DONE3/);
  assert.match(out, new RegExp(`^${at(10)}\\s+a\\s+img1\\s+10\\s+0\\s+50,000\\s+40,000\\s+yes$`, 'm'));
  assert.doesNotMatch(report(events, { last: null, minCreate: 15000, pairs: false }), /Compressed pairs/);
});

test('parseArgs and default log path', () => {
  assert.deepEqual(parseArgs(['--last', '600', '--pairs', '--min-create', '20000', '--log', 'x.jsonl']), {
    log: 'x.jsonl',
    last: 600,
    minCreate: 20000,
    pairs: true,
    includeUnknown: false,
    ttlSim: false,
    since: null,
  });
  assert.equal(parseArgs(['--include-unknown']).includeUnknown, true);
  assert.deepEqual([parseArgs(['--ttl-sim']).ttlSim, parseArgs(['--ttl-sim']).since], [true, null]);
  assert.equal(parseArgs(['--ttl-sim', '--since', '2026-11-18T10:00:00Z']).since, '2026-11-18T10:00:00Z');
  assert.throws(() => parseArgs(['--ttl-sim', '--since', 'yesterday']), (err) => err instanceof UsageError && /ISO date/.test(err.message));
  assert.throws(() => parseArgs(['--ttl-sim', '--since']), (err) => err instanceof UsageError && /needs a value/.test(err.message));
  assert.throws(() => parseArgs(['--since', '2026-11-18T10:00:00Z']), (err) => err instanceof UsageError && /needs --ttl-sim/.test(err.message));
  assert.equal(parseArgs(['--min-create', '0']).minCreate, 0);
  for (const bad of [['--last', 'abc'], ['--last', '0'], ['--last', '-5'], ['--last', '1.5'], ['--min-create', '-1']]) {
    assert.throws(() => parseArgs(bad), (err) => err instanceof UsageError && /needs an integer/.test(err.message), bad.join(' '));
  }
  for (const bad of [['--log'], ['--log', '--pairs'], ['--last'], ['--min-create'], ['--min-create', '--pairs']]) {
    assert.throws(() => parseArgs(bad), (err) => err instanceof UsageError && /needs a value/.test(err.message), bad.join(' '));
  }
  assert.throws(() => parseArgs(['--ttl-sm']), (err) => err instanceof UsageError && /unknown argument/.test(err.message));
  assert.equal(defaultLogPath({ PXPIPE_LOG: '/tmp/e.jsonl' }), '/tmp/e.jsonl');
  assert.equal(defaultLogPath({}), path.join(os.homedir(), '.pxpipe', 'events.jsonl'));
});

test('CLI reads the log without changing it and prints no prompt text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    const SECRET = 'PROMPT-TEXT-MUST-NOT-LEAK';
    fs.writeFileSync(file.replace(/\.jsonl$/, '.1.jsonl'), jsonl([ev(0, { session_id: 'old', input_tokens: 7 })]));
    fs.writeFileSync(file, jsonl([ev(60, { session_id: 's', input_tokens: 5, error: SECRET, cache_create_tokens: 20000 })]));
    const before = fs.readFileSync(file);
    const out = execFileSync(process.execPath, [SCRIPT, '--log', file, '--pairs'], { encoding: 'utf8', env: { ...process.env, PXPIPE_LOG: '' } });
    assert.match(out, /2 Claude requests/); // backup .1.jsonl read too
    assert.doesNotMatch(out, new RegExp(SECRET));
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['events.1.jsonl', 'events.jsonl']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 2 with a message on stderr for a bad command line', () => {
  for (const args of [['--last', '0'], ['--log'], ['--log', '--pairs'], ['--min-create']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PXPIPE_LOG: path.join(os.tmpdir(), 'cost-report-missing.jsonl') } });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^cost-report: /, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('--pairs skips requests without session_id unless --include-unknown, which prints a warning', () => {
  const events = loadEvents(
    jsonl([
      ev(0, { history_image_sha8: 'img1', cache_create_tokens: 50000 }),
      ev(10, { history_image_sha8: 'img1', cache_read_tokens: 40000 }),
      ev(20, { session_id: 'a', history_image_sha8: 'img1', cache_create_tokens: 1000 }),
      ev(30, { session_id: 'a', history_image_sha8: 'img1', cache_read_tokens: 800 }),
    ]),
  );
  assert.deepEqual(findPairs(events).map((p) => p.after.e.ts), [at(30)]);
  assert.deepEqual(findPairs(events, { includeUnknown: true }).map((p) => [p.after.session, p.after.e.ts]), [['unknown', at(10)], ['a', at(30)]]);
  const plain = report(events, { last: null, minCreate: 15000, pairs: true });
  assert.match(plain, /Compressed pairs .*: 1, DONE3 met: 1/);
  assert.doesNotMatch(plain, /WARNING/);
  const all = report(events, { last: null, minCreate: 15000, pairs: true, includeUnknown: true });
  assert.match(all, /Compressed pairs .*: 2, DONE3 met: 2\nWARNING: --include-unknown .*\nDONE3:/);
});

test('--ttl-sim: 5m vs 1h cost of the stable prefix per session_id + agent_role, hand-computed', () => {
  const a = { session_id: 'a', agent_role: 'main' };
  const events = loadEvents(
    jsonl([
      ev(-10, { ...a, cache_prefix_sha8: 'p1', cache_create_tokens: 99999 }), // before --since: ignored
      ev(0, { ...a, cache_prefix_sha8: 'p1', cache_create_tokens: 10000 }), // first: P 10000, write both
      ev(120, { session_id: 'b', agent_role: 'main', cache_prefix_sha8: 'p1', cache_create_tokens: 4000 }), // other session, same prefix: own chain
      ev(180, { session_id: 'a', agent_role: 'subagent', cache_prefix_sha8: 'p1', cache_create_tokens: 2000 }), // same session, other role: own chain
      ev(200, { cache_prefix_sha8: 'p1', cache_create_tokens: 3000 }), // no session_id: skipped
      ev(240, { ...a, cache_prefix_sha8: 'p1', cache_read_tokens: 10000, cache_create_tokens: 500 }), // 4 min: P min(10000,10500)=10000, read both
      ev(300, { ...a, cache_read_tokens: 50000 }), // delta body, no prefix: skipped, does not refresh
      ev(840, { ...a, cache_prefix_sha8: 'p1', cache_read_tokens: 10000, cache_create_tokens: 1000 }), // 10 min: P 10500, 5m writes, 1h reads
      ev(8040, { ...a, cache_prefix_sha8: 'p1', cache_create_tokens: 11000 }), // 2 h: P 11000, both write
      ev(8100, { ...a, cache_prefix_sha8: 'p2', cache_read_tokens: 5000, cache_create_tokens: 7000 }), // prefix changed after 1 min: P 12000, both write
    ]),
  );
  const sim = simulateTtl(events, t0);
  const k = sim.keys.get('a main');
  assert.equal(k.n, 5);
  // 5m: 10000x1.25 + 10000x0.1 + 10500x1.25 + 11000x1.25 + 12000x1.25 = 12500 + 1000 + 13125 + 13750 + 15000
  assert.deepEqual(k['5m'], { write: 43500, read: 10000, cost: 55375 });
  // 1h: 10000x2 + 10000x0.1 + 10500x0.1 + 11000x2 + 12000x2 = 20000 + 1000 + 1050 + 22000 + 24000
  assert.deepEqual(k['1h'], { write: 33000, read: 20500, cost: 68050 });
  // actual cache cost: 12500 + (1000+625) + (1000+1250) + 13750 + (500+8750)
  assert.equal(k.cacheCost, 39375);
  assert.deepEqual([sim.keys.get('b main')['5m'], sim.keys.get('b main')['1h']], [{ write: 4000, read: 0, cost: 5000 }, { write: 4000, read: 0, cost: 8000 }]);
  assert.deepEqual([sim.keys.get('a subagent')['5m'].cost, sim.keys.get('a subagent')['1h'].cost], [2500, 4000]);
  assert.equal(sim.keys.size, 3);
  assert.deepEqual(sim.skipped, { noSession: 1, noPrefix: 1 });
  assert.deepEqual(sim.gaps, { le5m: 2, le60m: 1, gt60m: 1 }); // 240, 60 | 600 | 7200
  // Other bound: the delta at 300 s keeps the prefix warm, so the request at 840 s is 540 s after it.
  // Still > 300 s, so 5m writes; the delta itself is not costed and the costs stay the same.
  const warm = simulateTtl(events, t0, { deltaRefresh: true });
  assert.deepEqual([warm.keys.get('a main')['5m'], warm.keys.get('a main')['1h']], [k['5m'], k['1h']]);
  // A delta 200 s before the next full request turns that 5m rewrite into a read: 10500x1.25 -> 10500x0.1.
  const close = loadEvents(jsonl([...events.map((x) => x.e), ev(700, { ...a, cache_read_tokens: 50000 })].sort((x, y) => x.ts.localeCompare(y.ts))));
  assert.deepEqual(simulateTtl(close, t0).keys.get('a main')['5m'], k['5m']);
  assert.deepEqual(simulateTtl(close, t0, { deltaRefresh: true }).keys.get('a main')['5m'], { write: 33000, read: 20500, cost: 55375 - 13125 + 1050 });
  const out = report(events, { last: null, minCreate: 15000, ttlSim: true, since: at(0) });
  // total 5m 62875, 1h 80050, diff +17175 = 36.6 % of the actual cache cost 46875
  assert.match(out, /\nTOTAL\s+7\s+49,500\s+10,000\s+62,875\s+39,000\s+20,500\s+80,050\s+\+17,175\s+36\.6%\n/);
  assert.match(out, /upper bound \(cận trên\)/);
  assert.match(out, /<= 5 min: 2, 5-60 min: 1, > 60 min: 1/);
  assert.match(out, /Skipped: 1 without session_id, 1 without cache_prefix_sha8/);
  assert.match(out, /delta bodies do not keep the prefix warm. If they do: cost_5m 62,875, cost_1h 80,050/);
  assert.doesNotMatch(report(events, { last: null, minCreate: 15000 }), /TTL simulation/);
});

test('--ttl-sim: history-image hit rate since the restart, with --pairs logic, preliminary under 10 pairs', () => {
  const img = (sec, s, extra) => ev(sec, { session_id: s, history_image_sha8: 'img', ...extra });
  const few = loadEvents(
    jsonl([
      img(-60, 'a', { cache_create_tokens: 50000 }), // before --since
      img(10, 'a', { cache_read_tokens: 50000 }), // pair with a row before --since: not counted
      img(20, 'a', { cache_read_tokens: 50000 }), // pair (10, 20), DONE3
      img(30, 'b', { cache_create_tokens: 40000 }),
      img(400, 'b', { cache_read_tokens: 40000 }), // > 5 min: no pair
    ]),
  );
  const out = report(few, { last: null, minCreate: 15000, ttlSim: true, since: at(0) });
  assert.match(out, /## Cache hit ảnh lịch sử since .*: 1 pairs, DONE3 met: 1 — sơ bộ \(< 10 pairs\)\n/);
  assert.match(out, /\na\s+2\s+1\s+1\s+100,000\s+0\s+100\.0%\n/);
  assert.match(out, /\nb\s+2\s+0\s+0\s+40,000\s+40,000\s+50\.0%/);
  const many = loadEvents(jsonl(Array.from({ length: 11 }, (_, i) => img(i * 10, 'c', { cache_read_tokens: 1000 }))));
  const out2 = report(many, { last: null, minCreate: 15000, ttlSim: true, since: at(0) });
  assert.match(out2, /: 10 pairs, DONE3 met: 10\n/);
  assert.doesNotMatch(out2, /sơ bộ/);
});

test('CLI --ttl-sim prints both costs and the difference, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cost-report-'));
  try {
    const file = path.join(dir, 'events.jsonl');
    fs.writeFileSync(file, jsonl([ev(0, { session_id: 's', agent_role: 'main', cache_prefix_sha8: 'p', cache_create_tokens: 1000 })]));
    const out = execFileSync(process.execPath, [SCRIPT, '--log', file, '--ttl-sim', '--since', at(0)], { encoding: 'utf8' });
    assert.match(out, /\nTOTAL\s+1\s+1,000\s+0\s+1,250\s+1,000\s+0\s+2,000\s+\+750\s+60\.0%\n/);
    const r = spawnSync(process.execPath, [SCRIPT, '--log', file, '--ttl-sim', '--since', 'nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
