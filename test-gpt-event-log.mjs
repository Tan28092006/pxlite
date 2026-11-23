import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGptEvent } from './gpt-event-log.mjs';
import { createGptPrefixTracker } from './gpt-prefix.mjs';
import { createGptCachePolicy, toGptCacheSeedEvent, analyzeGptCacheEvents } from './gpt-cache-policy.mjs';

const roundtrip = e => JSON.parse(JSON.stringify(projectGptEvent(e)));
const context = { sessionKey: 'test', model: 'gpt-6.1-sol', route: '/v1/responses', historyMode: 'summary' };
const options = { checkpointChunk: 130, projectionVersion: 5, keepTail: 30,
  preserveClientImages: true, checkpointBootstrap: false, reasoningMode: 'summary' };
const args = { candidateCutoff: 130, baselineTokens: 10000, candidateTokens: 1000,
  summaryMode: true, options, profile: { cacheReadRate: 0.1, cacheWriteRate: 1 } };
const event = (gate, cached = 0, time = 1000) => ({
  ts: new Date(time).toISOString(), model: context.model, path: context.route,
  status: 200, duration_ms: 0, first_byte_ms: 0, transform_ms: 0,
  input_tokens: 10000, cached_tokens: cached, output_tokens: 0, reasoning_output_tokens: 0,
  gpt_history_checkpoint_chunk: 130, first_user_sha8: 'user', system_sha8: 'sys',
  history_image_sha8: 'image', gpt_cache_gate: gate,
  gpt_prefix: { status: 'append_only', common_items: 2, previous_items: 2,
    current_items: 3, first_changed: { area: 'input', index: 2, before_type: null, after_type: 'message' } },
});

test('full opt-out and Claude are value-identical; projector never mutates nested state', () => {
  const raw = event({ chosen_options: options, baseline_tokens: 200, bootstrap: false });
  const snapshot = structuredClone(raw);
  assert.deepEqual(projectGptEvent(raw, { detail: 'full' }), raw);
  const claude = { ...raw, model: 'claude-opus-5-5', compressed: false };
  assert.deepEqual(projectGptEvent(claude), claude);
  const out = projectGptEvent(raw);
  out.gpt_cache_gate.chosen_options.keepTail = 999;
  assert.deepEqual(raw, snapshot);
});

test('zeros in usage, timing, cutoff and decisions remain explicit; unknown diagnostics and errors survive', () => {
  const raw = event({ held_cutoff: 0, candidate_cutoff: 0, chosen_cutoff: 0,
    accept: false, economic_accept: false, wire_applied: false,
    bootstrap: false, baseline_tokens: 200, stable_samples: 0 });
  Object.assign(raw, { error: 'test error', error_body: 'test body', request_id: 'req',
    response_id: 'resp', transport: { retry: false }, image_count: 0 });
  raw.gpt_upstream = { request_id: 'up-req', response_id: 'up-resp',
    has_transport_cache_header: false, cache_mode: 'default', anchors: 0 };
  const out = roundtrip(raw);
  for (const key of ['input_tokens', 'cached_tokens', 'output_tokens', 'reasoning_output_tokens',
    'duration_ms', 'first_byte_ms', 'transform_ms', 'error', 'error_body', 'request_id', 'response_id', 'transport'])
    assert.deepEqual(out[key], raw[key]);
  for (const key of ['held_cutoff', 'candidate_cutoff', 'chosen_cutoff', 'accept', 'economic_accept', 'wire_applied'])
    assert.equal(out.gpt_cache_gate[key], raw.gpt_cache_gate[key]);
  assert.equal(out.gpt_upstream.has_transport_cache_header, false);
  assert.equal(out.gpt_upstream.request_id, 'up-req');
  assert.equal(out.gpt_upstream.response_id, 'up-resp');
  assert.ok(!('baseline_tokens' in out.gpt_cache_gate));
  assert.ok(!('image_count' in out));
  assert.ok(!('cached_tokens' in roundtrip({ model: 'gpt-test' })));
});

test('compact seeds equal full seeds; restore retains options, closed witness, order and TTL', () => {
  const p = createGptCachePolicy({ now: () => 1000 });
  const gate = { ...p.forRequest(context).cacheGate.evaluate(args),
    closed_through: 129, closed_prefix_signature: 'ab'.repeat(32) };
  const raw = event(gate);
  const compact = roundtrip(raw);
  assert.deepEqual(toGptCacheSeedEvent(compact), toGptCacheSeedEvent(raw));
  const q = createGptCachePolicy({ now: () => 1001, events: [toGptCacheSeedEvent(compact)] });
  const held = q.forRequest(context).cacheGate;
  assert.equal(held.heldCutoff, 130);
  assert.deepEqual(held.heldOptions, options);
  assert.equal(held.heldClosedThrough, 129);
  assert.equal(held.heldSignature, gate.closed_prefix_signature);
  assert.ok(held.evaluate(args).request_seq > gate.request_seq);
  assert.equal(createGptCachePolicy({ now: () => 5000, ttlMs: 100, events: [compact] })
    .forRequest(context).cacheGate.heldCutoff, undefined);
  assert.equal(toGptCacheSeedEvent(roundtrip(event({ ...gate, wire_applied: false }))), null);
});

test('three explicit cache misses retain recovery behavior and statistical evidence', () => {
  const p = createGptCachePolicy({ now: () => 1000 });
  const gate = p.forRequest(context).cacheGate.evaluate(args);
  const rows = Array.from({ length: 4 }, (_, i) => event({ ...gate,
    request_seq: i + 1 }, 0, 1000 + i));
  rows[2].gpt_prefix = { ...rows[2].gpt_prefix, status: 'rewrite', common_items: 0 };
  const compact = rows.map(roundtrip);
  assert.deepEqual(analyzeGptCacheEvents(compact), analyzeGptCacheEvents(rows));
  const evaluate = events => createGptCachePolicy({ now: () => 1005, events })
    .forRequest(context).cacheGate.evaluate({ ...args, candidateCutoff: 260, candidateTokens: 11000 });
  assert.deepEqual(evaluate(compact), evaluate(rows));
  assert.equal(evaluate(compact).cache_miss_streak, 4);
  assert.equal(evaluate(compact).reason, 'cache_recovery_unproven');
});

function reports() {
  const tracker = createGptPrefixTracker({ includeDiff: true, maxDiffEntries: 64 });
  const body = { model: 'gpt-test', input: [{ role: 'user', content: 'first' }] };
  const observe = () => {
    const { diff, ...prefix } = tracker.observe(body, { sessionKey: 'test' });
    return { model: body.model, gpt_prefix: prefix, gpt_prefix_diff: diff };
  };
  return { body, observe };
}

test('routine prefix records retain counts and first differing position without block hashes or arrays', () => {
  const { body, observe } = reports();
  for (const raw of [observe(), observe(), (body.input.push({ role: 'assistant', content: 'next' }), observe())]) {
    const out = roundtrip(raw);
    assert.equal(out.gpt_prefix.status, raw.gpt_prefix.status);
    assert.deepEqual(out.gpt_prefix.first_changed, raw.gpt_prefix.first_changed);
    assert.deepEqual(out.gpt_prefix_diff.totals, raw.gpt_prefix_diff.totals);
    assert.equal(out.gpt_prefix_diff.total_changes, raw.gpt_prefix_diff.total_changes);
    assert.ok(!('changes' in out.gpt_prefix_diff));
    assert.ok(!JSON.stringify(out).includes('"hash"'));
    assert.ok(JSON.stringify(out).length < JSON.stringify(raw).length);
  }
});

test('rewrite and truncate keep changed block sizes and bounded positional details', () => {
  const { body, observe } = reports();
  body.input = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `${i}` }));
  observe();
  body.input.forEach(item => { item.content += ' changed'; });
  const raw = observe(), out = roundtrip(raw);
  assert.equal(out.gpt_prefix.status, 'rewrite');
  assert.equal(out.gpt_prefix_diff.changes.length, 8);
  assert.equal(out.gpt_prefix_diff.reported_changes, 8);
  assert.equal(out.gpt_prefix_diff.total_changes, raw.gpt_prefix_diff.total_changes);
  assert.equal(out.gpt_prefix_diff.truncated, true);
  assert.ok(Object.keys(out.gpt_prefix_diff.blocks).length > 0);
  assert.ok(!JSON.stringify(out).includes('"hash"'));
  body.input.pop();
  const truncated = roundtrip(observe());
  assert.equal(truncated.gpt_prefix.status, 'truncate');
  assert.ok(truncated.gpt_prefix_diff.changes.length > 0);
});

test('unknown prefix retains incomplete lower-bound counts, truncation and reason', () => {
  const tracker = createGptPrefixTracker({ includeDiff: true, maxUnits: 1 });
  const { diff, ...prefix } = tracker.observe({ model: 'gpt-test',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'a' }] }] }, { sessionKey: 'x' });
  const out = roundtrip({ model: 'gpt-test', gpt_prefix: prefix, gpt_prefix_diff: diff });
  assert.equal(out.gpt_prefix.status, 'unknown');
  assert.equal(out.gpt_prefix.reason, 'limit');
  assert.equal(out.gpt_prefix.truncated, true);
  assert.equal(out.gpt_prefix_diff.complete, false);
  assert.equal(out.gpt_prefix_diff.truncated, true);
  assert.equal(out.gpt_prefix_diff.totals_scope, diff.totals_scope);
});
