// Does the GPT summary planner re-render an already-closed prefix identically
// while only the live tail grows? A mismatch is reported by the proxy as
// `history_reset` / reason `archive_source_or_dependency_changed` and costs a
// full uncached rewrite. This drives the REAL cache policy (forRequest/record)
// and the REAL transformOpenAIResponses, one request per step, like production.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withEnv } from './lib-test-env.mjs';
import { createGptCachePolicy } from './gpt-cache-policy.mjs';
import { transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';

const enc = x => new TextEncoder().encode(JSON.stringify(x));
const MODEL = 'gpt-6.1-sol', ROUTE = '/v1/responses';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const opts = { reasoningMode: 'summary', checkpointChunk: 50, keepTail: 30,
  keepRecentPairs: 0, maxImages: 160, sectionTokens: 900, minCollapseTokens: 0,
  minCollapsePrefix: 0, preserveClientImages: true };
const env = { PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0,
  PXLITE_READ_NOTE: 0, PXLITE_FORCE_COLLAPSE_TOKENS: undefined };

const first = { role: 'user', content: 'Inspect C:/project/main.js, implement the fix and verify tests.' };
const turn = (i, { done = true, output = 'Build passed.\n'.repeat(80) } = {}) => [
  { type: 'reasoning', id: `r${i}`, encrypted_content: `OPAQUE_SECRET_${i}`,
    summary: [{ type: 'summary_text', text: `PUBLIC_STEP_${i}: verify the implementation against the completed checks.` }] },
  { role: 'assistant', content: `Inspect step ${i}. ` + 'Preserve test evidence and outstanding decisions. '.repeat(20) },
  { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: JSON.stringify({ command: `node check-${i}.mjs` }) },
  ...(done ? [{ type: 'function_call_output', call_id: `c${i}`, output }] : []),
];
const imageUser = i => ({ role: 'user', content: [
  { type: 'input_text', text: `Screenshot ${i}: please look at this.` },
  { type: 'input_image', image_url: PNG, detail: 'auto' }] });
const imageOutput = i => [
  { type: 'function_call', call_id: `s${i}`, name: 'screenshot', arguments: '{}' },
  { type: 'function_call_output', call_id: `s${i}`, output: [
    { type: 'input_text', text: 'captured' }, { type: 'input_image', image_url: PNG }] }];
const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);

// Drive one session. build(step) -> Responses `input`. restartAt: steps before
// which the policy is rebuilt from recorded events (proxy restart).
async function drive(build, steps, { restartAt = [] } = {}) {
  let clock = 1_000_000;
  const events = [];
  let policy = createGptCachePolicy({ now: () => clock, contextBudgetTokens: 0, events: [] });
  const rows = [];
  for (let s = 0; s < steps; s++) {
    if (restartAt.includes(s)) policy = createGptCachePolicy({
      now: () => clock, contextBudgetTokens: 0, events: structuredClone(events) });
    const h = policy.forRequest({ sessionKey: 'sess', model: MODEL, route: ROUTE, historyMode: 'summary' });
    const input = build(s);
    const out = await transformOpenAIResponses(enc({ model: MODEL, input }),
      { gptHistory: { ...opts, cacheGate: h.cacheGate } });
    const g = out.info.gptCacheGate;
    assert.ok(g, `step ${s}: no gptCacheGate in info`);
    const ev = { model: MODEL, path: ROUTE, status: 200, ts: new Date(clock).toISOString(),
      input_tokens: 100_000, cached_tokens: 90_000, gpt_cache_gate: g };
    h.record(ev);
    events.push(ev);
    clock += 5_000;
    rows.push({ step: s, items: input.length, accept: g.accept, reason: g.reason,
      closed: g.closed_through, sig: g.closed_prefix_signature, reset: g.history_reset === true,
      images: g.candidate_history_images });
  }
  return rows;
}
const table = rows => rows.map(r => `  step ${String(r.step).padStart(2)} items=${String(r.items).padStart(3)} `
  + `accept=${r.accept} closed=${r.closed} sig=${r.sig} reset=${r.reset ? 'YES' : 'no'} reason=${r.reason}`).join('\n');
const resets = rows => rows.filter(r => r.reset).map(r => r.step);
const report = (name, rows) => {
  console.log(`\n[${name}] resets at steps: ${JSON.stringify(resets(rows))}; accepted rewrites at: `
    + JSON.stringify(rows.filter((r, i) => i && r.closed !== rows[i - 1].closed).map(r => r.step)));
  if (process.env.PXLITE_TEST_TABLE) console.log(table(rows));
};

test('plain growth: closed prefix replays byte-identically while the tail grows', () => withEnv(env, async () => {
  const rows = await drive(s => [first, ...range(0, 45 + s).flatMap(i => turn(i))], 40);
  report('plain growth', rows);
  assert.ok(rows.some(r => r.closed > 0), 'scenario must actually close a prefix');
  assert.deepEqual(resets(rows), [], 'closed prefix changed without any source edit');
}));

test('open tool call completing in the next request does not disturb the closed prefix', () => withEnv(env, async () => {
  const build = s => {
    const done = 45 + Math.floor((s + 1) / 2);
    return [first, ...range(0, done).flatMap(i => turn(i)), ...(s % 2 === 0 ? turn(done, { done: false }) : [])];
  };
  const rows = await drive(build, 40);
  report('open call completes', rows);
  assert.ok(rows.some(r => r.closed > 0));
  assert.deepEqual(resets(rows), []);
}));

test('client images in the tail (user image + screenshot tool output) do not disturb the closed prefix', () => withEnv(env, async () => {
  const build = s => {
    const n = 45 + s, out = [first];
    for (const i of range(0, n)) {
      out.push(...turn(i));
      if (i === 52 || i === 60) out.push(imageUser(i));
      if (i === 56 || i === 66) out.push(...imageOutput(i));
    }
    return out;
  };
  const rows = await drive(build, 40);
  report('client images in tail', rows);
  assert.ok(rows.some(r => r.closed > 0));
  assert.deepEqual(resets(rows), []);
}));

test('proxy restart (policy rebuilt from recorded events) does not look like a source change', () => withEnv(env, async () => {
  const rows = await drive(s => [first, ...range(0, 45 + s).flatMap(i => turn(i))], 40, { restartAt: [8, 15, 27] });
  report('restart', rows);
  assert.ok(rows.some(r => r.closed > 0));
  assert.deepEqual(resets(rows), []);
}));

// The real policy above rejects every candidate after the first seal
// (min_gain_chars / cache_payback), so it never advances the cutoff. Force
// acceptance so each new 50-item chunk is sealed on top of the old pages and the
// previously closed prefix must replay unchanged.
async function driveForced(build, steps, { restartAt = [] } = {}) {
  let held, rows = [];
  for (let s = 0; s < steps; s++) {
    const gate = { heldCutoff: held?.chosen_cutoff, heldOptions: held?.chosen_options ?? {},
      heldClosedThrough: held?.closed_through, heldSignature: held?.closed_prefix_signature,
      evaluate: x => ({ accept: true, history_mode: 'summary', chosen_cutoff: x.candidateCutoff,
        chosen_options: x.options, reason: 'forced' }) };
    if (restartAt.includes(s)) { gate.heldClosedThrough = undefined; gate.heldSignature = undefined; }
    const out = await transformOpenAIResponses(enc({ model: MODEL, input: build(s) }),
      { gptHistory: { ...opts, cacheGate: gate } });
    const g = out.info.gptCacheGate;
    held = g;
    rows.push({ step: s, items: build(s).length, accept: g.accept, reason: g.reason,
      closed: g.closed_through, sig: g.closed_prefix_signature, reset: g.history_reset === true });
  }
  return rows;
}

test('FORCED advance: sealing new chunks keeps every earlier closed prefix intact', () => withEnv(env, async () => {
  const rows = await driveForced(s => [first, ...range(0, 45 + s).flatMap(i => turn(i))], 40);
  report('forced advance', rows);
  const advances = rows.filter((r, i) => i && r.closed > rows[i - 1].closed).length;
  assert.ok(advances >= 2, `cutoff must advance at least twice, advanced ${advances}x`);
  assert.deepEqual(resets(rows), []);
}));

test('FORCED advance + client images in the tail', () => withEnv(env, async () => {
  const build = s => {
    const out = [first];
    for (const i of range(0, 45 + s)) {
      out.push(...turn(i));
      if (i === 52 || i === 60) out.push(imageUser(i));
      if (i === 56 || i === 66) out.push(...imageOutput(i));
    }
    return out;
  };
  const rows = await driveForced(build, 40);
  report('forced advance + images', rows);
  const advances = rows.filter((r, i) => i && r.closed > rows[i - 1].closed).length;
  assert.ok(advances >= 2, `cutoff must advance at least twice, advanced ${advances}x`);
  assert.deepEqual(resets(rows), []);
}));

test('CONTROL: editing an old closed item IS detected as a reset', () => withEnv(env, async () => {
  const build = s => [first, ...range(0, 45 + s).flatMap(i => turn(i,
    s >= 12 && i === 3 ? { output: 'Build FAILED.\n'.repeat(80) } : {}))];
  const rows = await drive(build, 20);
  report('control (edit item c3 from step 12)', rows);
  assert.ok(resets(rows).length > 0, 'harness cannot detect a real source edit; a passing run above would be meaningless');
}));
