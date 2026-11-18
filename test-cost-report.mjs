// node --test test-cost-report.mjs
// scripts/cost-report.mjs on a synthetic events log (never the user's real log).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { costParts, defaultLogPath, findPairs, loadEvents, parseArgs, report, UsageError } from './scripts/cost-report.mjs';

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
  });
  assert.equal(parseArgs(['--include-unknown']).includeUnknown, true);
  assert.equal(parseArgs(['--min-create', '0']).minCreate, 0);
  for (const bad of [['--last', 'abc'], ['--last', '0'], ['--last', '-5'], ['--last', '1.5'], ['--min-create', '-1']]) {
    assert.throws(() => parseArgs(bad), (err) => err instanceof UsageError && /needs an integer/.test(err.message), bad.join(' '));
  }
  for (const bad of [['--log'], ['--log', '--pairs'], ['--last'], ['--min-create'], ['--min-create', '--pairs']]) {
    assert.throws(() => parseArgs(bad), (err) => err instanceof UsageError && /needs a value/.test(err.message), bad.join(' '));
  }
  assert.throws(() => parseArgs(['--ttl-sim']), (err) => err instanceof UsageError && /unknown argument/.test(err.message));
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
