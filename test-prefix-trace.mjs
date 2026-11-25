import assert from 'node:assert/strict';
import test from 'node:test';
import { withEnv } from './lib-test-env.mjs';
import { createPrefixTrace } from './prefix-trace.mjs';
import { createGptCachePolicy } from './gpt-cache-policy.mjs';
import { transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';

const range = n => Array.from({ length: n }, (_, i) => i);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const user0 = (images = 0) => ({ role: 'user', content: images
  ? [{ type: 'input_text', text: 'SECRET_TASK do the thing' }, ...range(images).map(() => ({ type: 'input_image', image_url: PNG }))]
  : 'SECRET_TASK do the thing' });
const turn = (i, out = `SECRET_OUT_${i} `.repeat(50)) => [
  { type: 'reasoning', id: `r${i}`, encrypted_content: `SECRET_ENC_${i}`, summary: [{ type: 'summary_text', text: `SECRET_SUM_${i}` }] },
  { role: 'assistant', content: `SECRET_ASSISTANT_${i}` },
  { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: JSON.stringify({ command: `SECRET_CMD_${i}` }) },
  { type: 'function_call_output', call_id: `c${i}`, output: out }];
const session = (n, first = user0()) => [first, ...range(n).flatMap(i => turn(i))];

function harness() {
  const rows = [];
  const trace = createPrefixTrace({ sink: r => rows.push(r) });
  let n = 0;
  const gate = (through, extra = {}) => ({ wire_applied: true, accept: true, chosen_cutoff: through,
    candidate_cutoff: through, closed_through: through, closed_prefix_signature: `sig${through}`,
    request_seq: ++n, ...extra });
  const step = (input, g, { instructions = 'INSTR', tools = [{ name: 't' }], status = 200, recallApplied = false } = {}) => {
    const p = trace.observe({ sid: 's1', model: 'gpt-x', route: '/v1/responses', recallApplied,
      parsed: { input, instructions, tools } });
    trace.finish(p, { status, gpt_cache_gate: g });
    return p;
  };
  return { rows, trace, gate, step };
}

test('append-only growth writes nothing', () => {
  const { rows, gate, step } = harness();
  for (let s = 0; s < 30; s++) step(session(20 + s), gate(40));
  assert.deepEqual(rows, []);
});

test('an old item inside the closed region changed: exact index, field and length', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40));
  step(session(21), gate(40));
  const edited = session(22);
  // index 16 = 1 + 4*3 + 3: the function_call_output of turn 3, outside the first-8 source key
  edited[16] = { ...edited[16], output: 'SECRET_EDITED' };
  step(edited, gate(40));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].reasons, ['closed_region_source_changed']);
  assert.equal(rows[0].source.first_changed, 16);
  assert.equal(rows[0].source.changed, 1);
  assert.equal(rows[0].source.items[0].type, 'function_call_output');
  assert.deepEqual(Object.keys(rows[0].source.items[0].changed), ['output']);
  assert.equal(rows[0].source.items[0].changed.output.len[1], '"SECRET_EDITED"'.length);
  assert.equal(rows[0].prev.closed_through, 40);
});

test('a change after the closed region is not reported', () => {
  const { rows, gate, step } = harness();
  step(session(30), gate(40));
  const edited = session(31);
  edited[100] = { ...edited[100], output: 'tail edit' };
  step(edited, gate(40));
  assert.deepEqual(rows, []);
});

test('first user message gains an image: source key + part-level diff', () => {
  const { rows, gate, step } = harness();
  step(session(20, user0(8)), gate(40));
  step(session(21, user0(9)), gate(40));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].reasons.includes('source_key_changed'));
  assert.deepEqual(rows[0].source_key.changed, ['user0', 'first8']);
  const it = rows[0].source.items[0];
  assert.equal(it.i, 0);
  assert.deepEqual(it.changed.content.parts.count, [9, 10]);
  assert.deepEqual(it.changed.content.parts.added_types, ['input_image']);
});

test('instructions-only change is attributed to instructions', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40), { instructions: 'A' });
  step(session(21), gate(40), { instructions: 'B' });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].reasons, ['source_key_changed']);
  assert.deepEqual(rows[0].source_key.changed, ['instructions']);
  assert.equal(rows[0].source.changed, 0);
});

test('insertion near the start is recognised as a shift, not as 100 edits', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40));
  const s = session(21);
  s.splice(10, 0, { role: 'developer', content: 'x' }, { role: 'developer', content: 'y' }, { role: 'developer', content: 'z' });
  step(s, gate(40));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source.shift.kind, 'inserted');
  assert.equal(rows[0].source.shift.at, 10);
  assert.equal(rows[0].source.shift.count, 3);
  assert.equal(rows[0].source.shift.residual_changed, 0);
});

test('planner reset with an UNCHANGED source is labelled as a planner problem', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40));
  step(session(21), gate(40, { history_reset: true, reason: 'archive_source_or_dependency_changed', economic_reason: 'cache_payback_met' }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].reasons, ['planner_reset']);
  assert.equal(rows[0].source.changed, 0);
  assert.equal(rows[0].gate.economic_reason, 'cache_payback_met');
});

test('signature drift at the same cutoff is reported even without a reset flag', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40));
  step(session(21), gate(40, { closed_prefix_signature: 'different' }));
  assert.deepEqual(rows.map(r => r.reasons), [['signature_changed_same_cutoff']]);
});

test('out-of-order completion of parallel requests keeps the newest state', () => {
  const { rows, trace, gate } = harness();
  const mk = n => ({ sid: 's1', model: 'gpt-x', route: '/v1/responses', parsed: { input: session(n), instructions: 'I', tools: [] } });
  const first = trace.observe(mk(20)); trace.finish(first, { status: 200, gpt_cache_gate: gate(40) });
  const a = trace.observe(mk(21)), b = trace.observe(mk(22));
  trace.finish(b, { status: 200, gpt_cache_gate: gate(40) });
  trace.finish(a, { status: 200, gpt_cache_gate: gate(40) });
  const c = trace.observe(mk(23));
  assert.equal(c.scan.changed, 0);
  trace.finish(c, { status: 200, gpt_cache_gate: gate(40) });
  assert.deepEqual(rows, []);
});

test('a failed upstream request does not move the closed boundary', () => {
  const { rows, gate, step } = harness();
  step(session(20), gate(40));
  step(session(21), undefined, { status: 502 });
  const edited = session(22);
  edited[30] = { ...edited[30], output: 'changed' };
  step(edited, gate(40));
  assert.equal(rows.length, 1, 'boundary 40 from the last good request must still apply');
  assert.equal(rows[0].source.first_changed, 30);
});

test('garbage input never throws and never records', () => {
  const { trace } = harness();
  for (const parsed of [null, {}, { input: 'text' }, { input: [null] }, { input: [1] }, { input: [{}], tools: 1n === 1n ? undefined : 0 }]) {
    const p = trace.observe({ sid: 's', model: 'm', route: 'r', parsed });
    trace.finish(p, { status: 200 });
  }
  trace.finish(undefined, undefined);
  assert.equal(trace.stats().errors, 0);
});

test('rows hold hashes, lengths and type tags only: no content', () => {
  const { rows, gate, step } = harness();
  step(session(20, user0(8)), gate(40));
  const edited = session(21, user0(9));
  edited[5] = { ...edited[5], output: 'SECRET_EDITED' };
  step(edited, gate(40, { history_reset: true }));
  assert.ok(rows.length >= 1);
  const text = JSON.stringify(rows);
  assert.ok(!/SECRET|iVBOR|do the thing|INSTR/.test(text), text.match(/.{20}(SECRET|iVBOR).{20}/)?.[0]);
});

test('overhead: 3000 items incl. 30 x 200 KB images', () => {
  const big = 'A'.repeat(200_000);
  const input = [user0(), ...range(750).flatMap(i => turn(i))];
  for (let k = 0; k < 30; k++) input[10 + k * 40] = { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${big}` }] };
  const { trace } = harness();
  const p = trace.observe({ sid: 's', model: 'm', route: 'r', parsed: { input, tools: [] } });
  const q = trace.observe({ sid: 's', model: 'm', route: 'r', parsed: { input, tools: [] } });
  console.log(`  observe ${input.length} items, ${(JSON.stringify(input).length / 1e6).toFixed(1)} MB: ${p.ms.toFixed(1)} ms (second: ${q.ms.toFixed(1)} ms)`);
  assert.ok(p.ms < 1500);
});

// ---- end to end against the REAL planner and cache policy ----------------------------
const enc = x => new TextEncoder().encode(JSON.stringify(x));
const MODEL = 'gpt-6.1-sol', ROUTE = '/v1/responses';
const opts = { reasoningMode: 'summary', checkpointChunk: 50, keepTail: 30, keepRecentPairs: 0,
  maxImages: 160, sectionTokens: 900, minCollapseTokens: 0, minCollapsePrefix: 0, preserveClientImages: true };
const env = { PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_READ_NOTE: 0,
  PXLITE_FORCE_COLLAPSE_TOKENS: undefined };

async function e2e(build, steps) {
  const rows = [], trace = createPrefixTrace({ sink: r => rows.push(r) });
  let clock = 1_000_000;
  const policy = createGptCachePolicy({ now: () => clock, contextBudgetTokens: 0, events: [] });
  for (let s = 0; s < steps; s++) {
    const input = build(s);
    const h = policy.forRequest({ sessionKey: 'sess', model: MODEL, route: ROUTE, historyMode: 'summary' });
    const pending = trace.observe({ sid: 'sess', model: MODEL, route: ROUTE, parsed: { input, instructions: 'I', tools: [] } });
    const out = await transformOpenAIResponses(enc({ model: MODEL, input }), { gptHistory: { ...opts, cacheGate: h.cacheGate } });
    const g = out.info.gptCacheGate;
    const ev = { model: MODEL, path: ROUTE, status: 200, ts: new Date(clock).toISOString(),
      input_tokens: 100_000, cached_tokens: 90_000, gpt_cache_gate: g };
    h.record(ev);
    trace.finish(pending, ev);
    clock += 5_000;
  }
  return rows;
}

test('E2E real planner: clean growth stays silent', () => withEnv(env, async () => {
  const rows = await e2e(s => session(45 + s), 20);
  assert.deepEqual(rows, []);
}));

test('E2E real planner: edit of an old closed item -> planner_reset AND the exact source index', () => withEnv(env, async () => {
  const build = s => { const x = session(45 + s); if (s >= 12) x[16] = { ...x[16], output: 'Build FAILED.\n'.repeat(80) }; return x; };
  const rows = await e2e(build, 20);
  assert.equal(rows.length, 1, JSON.stringify(rows.map(r => r.reasons)));
  assert.deepEqual(rows[0].reasons.sort(), ['closed_region_source_changed', 'planner_reset']);
  assert.equal(rows[0].source.first_changed, 16, 'turn 3 output = 1 + 4*3 + 3');
  assert.equal(rows[0].source.items[0].type, 'function_call_output');
  assert.equal(rows[0].gate.history_reset, true);
}));
