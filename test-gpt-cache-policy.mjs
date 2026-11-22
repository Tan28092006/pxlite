import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { analyzeGptCacheEvents, createGptCachePolicy, evaluateCacheTransition, toGptCacheSeedEvent } from './gpt-cache-policy.mjs';

test('launcher seed boundary excludes unapplied native fallbacks and retains valid closed-prefix metadata', () => {
  const now = () => 1000;
  const context = { sessionKey: 'seed-boundary', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary', sourceKey: 'source-root' };
  const p = createGptCachePolicy({ now });
  const g = p.forRequest(context).cacheGate.evaluate({
    candidateCutoff: 50, baselineTokens: 10000, candidateTokens: 1000,
    reasoningRemoved: 10, summaryMode: true,
    options: { reasoningMode: 'summary', keepTail: 30 },
    profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 },
  });
  const native = { ts: new Date(now()).toISOString(), model: context.model,
    path: context.route, status: 200, input_tokens: 10000, cached_tokens: 0,
    body: 'PRIVATE_BODY_NEVER_SEED', error_body: 'PRIVATE_ERROR_NEVER_SEED',
    gpt_cache_gate: { ...g, wire_applied: false, closed_through: 49,
      closed_prefix_signature: 'a'.repeat(64) } };
  assert.equal(toGptCacheSeedEvent(native), null);
  const restored = createGptCachePolicy({ now, events: [native].map(toGptCacheSeedEvent).filter(Boolean) });
  assert.equal(restored.forRequest(context).cacheGate.heldCutoff, undefined);
  const applied = toGptCacheSeedEvent({ ...native,
    gpt_cache_gate: { ...native.gpt_cache_gate, wire_applied: true } });
  assert.equal(applied._cache_observed_at, 1000);
  assert.ok(!JSON.stringify(applied).includes('PRIVATE_'));
  const good = createGptCachePolicy({ now, events: [applied] }).forRequest(context).cacheGate;
  assert.equal(good.heldCutoff, 50);
  assert.equal(good.heldClosedThrough, 49);
  assert.equal(good.heldSignature, 'a'.repeat(64));
  for (const invalid of [null, undefined, {}, { model: 'claude-opus-5-5' }])
    assert.equal(toGptCacheSeedEvent(invalid), null);
});

const costs = { baselineTokens: 100_000, candidateTokens: 80_000, readRate: 0.1,
  writeRate: 1.25, warmRatio: 1, rewriteRatio: 0, horizon: 3 };
test('live 1900 checkpoint: an identical visible prefix is not provider cache evidence', () => {
  const p = createGptCachePolicy({ now: () => 1, contextBudgetTokens: 0 });
  const ctx = { sessionKey: 'full-miss-regression', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const options = { projectionVersion: 5, checkpointChunk: 130 };
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1 };
  const request = p.forRequest(ctx);
  const boot = request.cacheGate.evaluate({ candidateCutoff: 1820, baselineTokens: 400000,
    candidateTokens: 127749, options, profile, summaryMode: true });
  request.record({ ...event('full-miss', 127749, 127000), gpt_cache_gate: boot });
  const g = p.forRequest(ctx).cacheGate.evaluate({ candidateCutoff: 1950,
    baselineTokens: 127749, candidateTokens: 110588, preservedPrefixTokens: 93980,
    savedTextChars: 80000, options, profile, summaryMode: true, reasoningRemoved: 11 });
  assert.equal(g.accept, false);
  assert.equal(g.preserved_prefix_tokens, 0);
  assert.equal(g.rewrite_ratio, 0);
  assert.ok(g.payback_reads >= 50, JSON.stringify(g));
});
test('history cannot bypass the 40000-character gain floor, including at the context budget', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const ctx = { sessionKey: 'gain-floor-regression', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const options = { projectionVersion: 5, checkpointChunk: 130 };
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1 };
  const first = p.forRequest(ctx);
  const boot = first.cacheGate.evaluate({ candidateCutoff: 130, baselineTokens: 500000,
    candidateTokens: 200000, options, profile, summaryMode: true });
  first.record({ ...event('gain-floor', 200000, 199000), gpt_cache_gate: boot });
  const args = { candidateCutoff: 260, baselineTokens: 200000, candidateTokens: 80000,
    options, profile, summaryMode: true, savedTextChars: 39999 };
  const request = p.forRequest(ctx);
  const held = request.cacheGate.evaluate(args);
  assert.equal(held.accept, false);
  assert.equal(held.reason, 'min_gain_chars');
  assert.equal(held.chosen_cutoff, 130);
  assert.equal(request.cacheGate.evaluate({ ...args, savedTextChars: 40000 }).accept, true);
  assert.equal(request.cacheGate.evaluate({ ...args, candidateCutoff: 130 }).reason, 'same_epoch_or_wire');
});
test('v5 summary uses the Claude planning horizon when source-epoch evidence is absent', () => {
  const p = createGptCachePolicy({ contextBudgetTokens: 0 });
  const ctx = { sessionKey: 'claude-horizon', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const first = p.forRequest(ctx);
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1 };
  const boot = first.cacheGate.evaluate({ candidateCutoff: 50,
    baselineTokens: 200000, candidateTokens: 100000,
    options: { projectionVersion: 5 }, profile });
  first.record({ ...event('horizon', 100000, 100000), gpt_cache_gate: boot });
  const g = p.forRequest(ctx).cacheGate.evaluate({ candidateCutoff: 100,
    baselineTokens: 100000, candidateTokens: 50000, summaryMode: true,
    options: { projectionVersion: 5 }, profile });
  assert.equal(g.accept, true);
  assert.equal(g.horizon, 10);
  assert.equal(g.horizon_basis, 'claude_default');
});

test('opaque retirement cannot override a financial rejection below the context budget', () => {
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1 };
  const args = { candidateCutoff: 50, baselineTokens: 10000, candidateTokens: 10200,
    summaryMode: true, reasoningRemoved: 10, baselineOpaqueItems: 40, candidateOpaqueItems: 30,
    sealedPrefixPreserved: true, opaquePrefixChanged: true,
    options: { projectionVersion: 5 }, profile };
  const make = () => createGptCachePolicy({ contextBudgetTokens: 0 }).forRequest({
    sessionKey: 'reasoning-retention', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' }).cacheGate;
  const g = make().evaluate(args);
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'no_token_gain');
  for (const bad of [
    { sealedPrefixPreserved: false }, { reasoningRemoved: 0 },
    { candidateOpaqueItems: 40 },
    { options: { projectionVersion: 4 } }, { candidateCutoff: 0 },
    { baselineTokens: NaN },
  ]) assert.equal(make().evaluate({ ...args, ...bad }).accept, false, JSON.stringify(bad));
  const largerSummary = make().evaluate({ ...args, candidateTokens: 15000 });
  assert.equal(largerSummary.accept, false);
  assert.equal(largerSummary.reason, 'no_token_gain');
});

test('future zero cache hits are priced as full input, not guaranteed cached reads', () => {
  const g = evaluateCacheTransition({ ...costs, warmRatio: 0,
    futureCacheRatio: 0, horizon: 3 });
  assert.equal(g.baseline_cost, 400000);
  assert.equal(g.candidate_cost, 340000);
  assert.equal(g.payback_reads, 0);
  assert.equal(g.accept, true);
  for (const futureCacheRatio of [-1, 2, NaN])
    assert.equal(evaluateCacheTransition({ ...costs, futureCacheRatio }).reason, 'invalid_estimate');
});

test('live-log pattern: unrecovered session holds a marginal rewrite, permits immediate savings and recovers', () => {
  let clock = 1000;
  const p = createGptCachePolicy({ now: () => clock++, contextBudgetTokens: 180000 });
  const ctx = { sessionKey: 'miss-loop', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const options = { projectionVersion: 5, checkpointChunk: 50 };
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1.25 };
  const args = { candidateCutoff: 1750, baselineTokens: 134355,
    candidateTokens: 112054, options, profile, summaryMode: true };
  const first = p.forRequest(ctx);
  const boot = first.cacheGate.evaluate({ ...args, baselineTokens: 300000 });
  first.record({ ...event('new', 112054, 0), gpt_cache_gate: boot });
  for (let i = 0; i < 8; i++) {
    const request = p.forRequest(ctx);
    const g = request.cacheGate.evaluate({ ...args, baselineTokens: 112054,
      candidateTokens: 112054, sameWire: true });
    assert.equal(g.reason, 'same_epoch_or_wire');
    request.record({ ...event('new', 112054, 0), gpt_cache_gate: g });
  }
  const candidate = { ...args, candidateCutoff: 1800, baselineTokens: 112054,
    candidateTokens: 105000, sealedPrefixPreserved: true,
    baselineOpaqueItems: 40, candidateOpaqueItems: 30, reasoningRemoved: 10 };
  const request = p.forRequest(ctx);
  const held = request.cacheGate.evaluate(candidate);
  assert.equal(held.cache_miss_streak, 9);
  assert.equal(held.cache_health, 'unrecovered');
  assert.equal(held.recent_cache_ratio, 0);
  assert.equal(held.accept, false);
  assert.equal(held.reason, 'cache_recovery_unproven');
  assert.equal(held.chosen_cutoff, 1750);
  const large = request.cacheGate.evaluate({ ...candidate, candidateTokens: 70000 });
  assert.equal(large.accept, true, 'do not block a rewrite that pays without future cache hits');
  const seed = toGptCacheSeedEvent({ ...event('new', 112054, 0),
    ts: new Date(clock).toISOString(), gpt_cache_gate: held });
  const restored = createGptCachePolicy({ now: () => clock, events: [...Array(4)].map(() => seed),
    contextBudgetTokens: 180000 });
  assert.equal(restored.forRequest(ctx).cacheGate.evaluate(candidate).reason, 'cache_recovery_unproven');
  const other = p.forRequest({ ...ctx, sessionKey: 'different-session' }).cacheGate.evaluate(candidate);
  assert.equal(other.cache_miss_streak, 0);
  for (let i = 0; i < 3; i++) {
    const r = p.forRequest(ctx);
    const g = r.cacheGate.evaluate({ ...args, baselineTokens: 112054,
      candidateTokens: 112054, sameWire: true });
    r.record({ ...event('new', 112054, 110000), gpt_cache_gate: g });
  }
  const recovered = p.forRequest(ctx).cacheGate.evaluate(candidate);
  assert.equal(recovered.cache_miss_streak, 0);
  assert.ok(recovered.recent_cache_ratio > 0.9);
  assert.notEqual(recovered.reason, 'cache_recovery_unproven');
});
test('a smaller checkpoint is rejected when reloading the whole prefix cannot pay back', () => {
  const g = evaluateCacheTransition(costs);
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'cache_payback');
  assert.equal(g.payback_reads, 45);
  assert.equal(g.baseline_cost, 40_000);
  assert.equal(g.candidate_cost, 124_000);
});
test('a sufficiently small replacement pays back within the observed horizon', () => {
  const g = evaluateCacheTransition({ ...costs, candidateTokens: 10_000, horizon: 1 });
  assert.equal(g.accept, true);
  assert.equal(g.payback_reads, 1);
  assert.equal(g.baseline_cost, 20_000);
  assert.equal(g.candidate_cost, 13_500);
});
test('cold bootstrap may compress immediately without inventing existing cache', () => {
  const g = evaluateCacheTransition({ ...costs, warmRatio: 0, horizon: 0 });
  assert.equal(g.accept, false); // a 1.25x write of 80k merely ties 100k
  assert.equal(evaluateCacheTransition({ ...costs, warmRatio: 0, horizon: 0, candidateTokens: 20_000 }).accept, true);
});
test('no token reduction and malformed estimates cannot be approved', () => {
  assert.equal(evaluateCacheTransition({ ...costs, candidateTokens: 100_000 }).reason, 'no_token_gain');
  for (const value of [NaN, Infinity, -1, undefined])
    assert.equal(evaluateCacheTransition({ ...costs, baselineTokens: value }).reason, 'invalid_estimate');
  assert.equal(evaluateCacheTransition({ ...costs, readRate: 0 }).reason, 'invalid_estimate');
});
const event = (hash, input = 1000, cached = 950, extra = {}) => ({
  model: 'gpt-6.1-sol', path: '/v1/responses', status: 200,
  first_user_sha8: 'one-session', system_sha8: 'sys', gpt_history_checkpoint_chunk: 50,
  history_image_sha8: hash, input_tokens: input, cached_tokens: cached, ...extra,
});
test('statistics use completed warm runs, include real zero hits, and isolate model/route/session', () => {
  const stats = analyzeGptCacheEvents([
    event('a'), event('a'), event('a'), event('b', 1000, 0),
    event('b'), event('b'), event('c', 1000, 0),
    event('c', 1000, 999, { model: 'gpt-6.2-sol' }),
    event('x', 1000, 0, { first_user_sha8: 'different-session' }),
    event('x', 1000, 0, { path: '/backend-api/codex/responses' }),
    event('bad', 1000, 0, { status: 400 }),
  ]);
  const s = stats['gpt-6.1-sol|/v1/responses'];
  assert.equal(s.rewrite_samples, 2);
  assert.equal(s.stable_samples, 4);
  assert.equal(s.horizon, 2);
  assert.equal(s.warm_ratio, 0.95);
  assert.equal(s.rewrite_ratio, 0);
});

test('summary horizon uses completed source epochs instead of the old projector rewrite frequency', () => {
  const events = [];
  for (let epoch = 0; epoch < 6; epoch++) for (let read = 0; read < 6; read++)
    // Half the historical rewrites actually missed; retain that pessimistic
    // rewrite-cost evidence while learning the separate source-grid lifetime.
    events.push(event(`rewrite-${epoch}-${read}`, 10000, read < 3 ? 0 : 9500, {
      gpt_cache_gate: { session: 'source-grid', history_mode: 'summary',
        candidate_cutoff: epoch * 50, chosen_cutoff: 0,
        chosen_options: { checkpointChunk: 50 } },
      // Repeated rewrites in the retired implementation must not predict a
      // one-request lifetime for the fixed 50-source-item policy.
      gpt_prefix: { status: 'rewrite', common_items: 1, previous_items: 30, current_items: 30 },
    }));
  const raw = analyzeGptCacheEvents(events)['gpt-6.1-sol|/v1/responses'];
  assert.equal(raw.horizon, 5);
  assert.equal(raw.horizon_basis, 'source_epochs');
  assert.equal(raw.source_epoch_samples, 4);
  assert.equal(raw.rewrite_ratio, 0);
  const seeded = analyzeGptCacheEvents(events.map(toGptCacheSeedEvent))['gpt-6.1-sol|/v1/responses'];
  assert.equal(seeded.horizon, raw.horizon);
  assert.equal(seeded.source_epoch_samples, raw.source_epoch_samples);
});

test('partial, skipped and cross-session source epochs do not invent future reads', () => {
  const events = [0, 50, 150, 100, 200].map((cutoff, i) => event(`h${i}`, 1000, 900, {
    gpt_cache_gate: { session: i === 4 ? 'different' : 'same', history_mode: 'summary',
      candidate_cutoff: cutoff, chosen_options: { checkpointChunk: 50 } },
  }));
  const s = analyzeGptCacheEvents(events)['gpt-6.1-sol|/v1/responses'];
  assert.equal(s.source_epoch_samples, 0);
  assert.equal(s.horizon_basis, 'rewrites');
});
test('rejected transitions retain the approved cutoff, not a newly selected native prefix', () => {
  const p = createGptCachePolicy();
  const a = p.forRequest({ sessionKey: 'private-key', model: 'gpt-6.1-sol', route: '/v1/responses' });
  const first = a.cacheGate.evaluate({ candidateCutoff: 50, baselineTokens: 100_000,
    candidateTokens: 10_000, profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 } });
  assert.equal(first.accept, true);
  a.record({ ...event('a', 10_000, 0), gpt_cache_gate: first });
  const b = p.forRequest({ sessionKey: 'private-key', model: 'gpt-6.1-sol', route: '/v1/responses' });
  assert.equal(b.cacheGate.heldCutoff, 50);
  const no = b.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 100_000,
    candidateTokens: 80_000, profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 } });
  assert.equal(no.accept, false);
  assert.equal(no.chosen_cutoff, 50);
  b.record({ ...event('a', 100_000, 95_000), gpt_cache_gate: no });
  assert.equal(p.forRequest({ sessionKey: 'private-key', model: 'gpt-6.1-sol', route: '/v1/responses' }).cacheGate.heldCutoff, 50);
  assert.ok(!JSON.stringify(no).includes('private-key'));
});
test('failed requests do not commit, no-key requests do not share state, and TTL expires', () => {
  let now = 0;
  const p = createGptCachePolicy({ now: () => now, ttlMs: 100 });
  const req = () => p.forRequest({ sessionKey: 's', model: 'gpt-6.1-sol', route: '/v1/responses' });
  const a = req();
  const g = a.cacheGate.evaluate({ candidateCutoff: 50, baselineTokens: 1000, candidateTokens: 10,
    profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 } });
  a.record({ ...event('a'), status: 400, gpt_cache_gate: g });
  assert.equal(req().cacheGate.heldCutoff, undefined);
  a.record({ ...event('a'), gpt_cache_gate: g });
  assert.equal(req().cacheGate.heldCutoff, 50);
  now = 101;
  assert.equal(req().cacheGate.heldCutoff, undefined);
  assert.equal(p.forRequest({ model: 'gpt-6.1-sol', route: '/v1/responses' }), null);
});

test('new prefix diagnostics distinguish appended image pages from a real rewrite', () => {
  const events = ['a', 'ab', 'abc', 'abcd'].map((hash, i) => event(hash, 1000, 990, {
    gpt_prefix: { status: i ? 'append_only' : 'first', common_items: i * 4,
      previous_items: i * 4, current_items: (i + 1) * 4 },
  }));
  const s = analyzeGptCacheEvents(events)['gpt-6.1-sol|/v1/responses'];
  assert.equal(s.stable_samples, 3);
  assert.equal(s.rewrite_samples, 0);
  assert.equal(s.rewrite_ratio, 0);
});
test('restoring a seed does not renew its provider-evidence TTL', () => {
  let now = 0;
  const p = createGptCachePolicy({ now: () => now, ttlMs: 100 });
  const context = { sessionKey: 'restore', model: 'gpt-6.1-sol', route: '/v1/responses' };
  const a = p.forRequest(context);
  const g = a.cacheGate.evaluate({ candidateCutoff: 50, baselineTokens: 1000, candidateTokens: 10,
    profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 } });
  const seed = { ...event('a'), ts: new Date(0).toISOString(), gpt_cache_gate: g };
  const q = createGptCachePolicy({ events: [seed], now: () => now, ttlMs: 100 });
  now = 99;
  assert.equal(q.forRequest(context).cacheGate.heldCutoff, 50);
  now = 150;
  assert.equal(q.forRequest(context).cacheGate.heldCutoff, undefined);
});
test('late completions cannot overwrite newer calibration or restore an older epoch', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const context = { sessionKey: 'parallel', model: 'gpt-6.1-sol', route: '/v1/responses' };
  const a = p.forRequest(context), b = p.forRequest(context);
  const args = { candidateCutoff: 50, baselineTokens: 1000, candidateTokens: 100,
    profile: { cacheReadRate: 0.1, cacheWriteRate: 1.25 } };
  const ga = a.cacheGate.evaluate(args), gb = b.cacheGate.evaluate(args);
  b.record({ ...event('a', 3000), gpt_cache_gate: gb });
  a.record({ ...event('a', 1000), gpt_cache_gate: ga });
  const g = p.forRequest(context).cacheGate.evaluate({ ...args, candidateCutoff: 100 });
  assert.equal(g.calibration_offset, 2900);
  const q = createGptCachePolicy({ now: () => 2, events: [
    { ...event('a', 3000), ts: new Date(1).toISOString(), gpt_cache_gate: { ...gb, chosen_cutoff: 100 } },
    { ...event('a', 1000), ts: new Date(1).toISOString(), gpt_cache_gate: ga },
  ] });
  assert.equal(q.forRequest(context).cacheGate.heldCutoff, 100);
});

const context = { sessionKey: 'summary-session', model: 'gpt-6.1-sol', route: '/v1/responses',
  historyMode: 'summary' };
const profile = { cacheReadRate: 0.1, cacheWriteRate: 1.25 };
const planning = { reasoningMode: 'summary', keepTail: 30, responsesMode: 'pairs',
  checkpointChunk: 100, sectionTokens: 3000, preserveClientImages: true };
const advance = { candidateCutoff: 200, baselineTokens: 100, candidateTokens: 80, profile };
function approved(p, ctx = context, usage = {}) {
  const { input = 100_000, options = planning } = usage;
  const cached = Object.hasOwn(usage, 'cached') ? usage.cached : 90_000;
  const a = p.forRequest(ctx);
  const g = a.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 1000,
    candidateTokens: 100, options, profile });
  assert.equal(g.accept, true);
  const seed = { ...event('approved', input, cached, { cached_tokens: cached }),
    ts: new Date(1).toISOString(), gpt_cache_gate: g };
  a.record(seed);
  return seed;
}

test('212577-token reasoning checkpoint rejects a near-identical candidate and holds cutoff 1000', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const first = p.forRequest(context);
  const seed = first.cacheGate.evaluate({ candidateCutoff: 1000, baselineTokens: 1_000_000,
    candidateTokens: 212_577, options: planning, profile });
  assert.equal(seed.accept, true);
  first.record({ ...event('warm', 212_577, 200_000), gpt_cache_gate: seed });
  const request = p.forRequest(context);
  assert.equal(request.cacheGate.heldCutoff, 1000);
  const g = request.cacheGate.evaluate({ candidateCutoff: 1050,
    baselineTokens: 212_577, candidateTokens: 212_576, preservedPrefixTokens: 100_000,
    summaryMode: true, reasoningRemoved: 10, options: { ...planning, keepTail: 45 }, profile });
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'cache_payback');
  assert.equal(g.chosen_cutoff, 1000);
  assert.equal(g.candidate_cutoff, 1050);
  assert.equal(g.baseline_tokens, 212_577);
  assert.equal(g.candidate_tokens, 212_576);
  assert.equal(g.calibration_offset, 0);
  assert.equal(g.preserved_prefix_tokens, 100_000);
  assert.ok(g.candidate_cost > g.baseline_cost);
  assert.deepEqual(g.chosen_options, planning);
  assert.equal(g.selected_local_tokens, 212_577);
  request.record({ ...event('held', 212_577, 0), gpt_cache_gate: g });
  assert.equal(p.forRequest(context).cacheGate.heldCutoff, 1000);
});

test('preserved-prefix credit has a strict partial-payback boundary and a full-prefix cap', () => {
  const args = { baselineTokens: 100, candidateTokens: 80, readRate: 0.5, horizon: 1 };
  assert.deepEqual(evaluateCacheTransition(costs),
    evaluateCacheTransition({ ...costs, preservedPrefixTokens: 0 }));
  const tie = evaluateCacheTransition({ ...args, preservedPrefixTokens: 40 });
  assert.equal(tie.accept, false);
  assert.equal(tie.baseline_cost, 100);
  assert.equal(tie.candidate_cost, 100);
  assert.equal(tie.payback_reads, 1);
  const over = evaluateCacheTransition({ ...args, preservedPrefixTokens: 41 });
  assert.equal(over.accept, true); // Do not compare rounded costs.
  assert.equal(over.preserved_prefix_tokens, 41);
  assert.equal(evaluateCacheTransition({ ...args, preservedPrefixTokens: 39 }).accept, false);
  const full = evaluateCacheTransition({ ...args, preservedPrefixTokens: 80 });
  assert.equal(full.candidate_cost, 80);
  assert.equal(full.payback_reads, 0);
  assert.deepEqual(evaluateCacheTransition({ ...args, preservedPrefixTokens: 1000 }), full);
});
test('only the changed suffix uses sampled warm and rewrite ratios', () => {
  const g = evaluateCacheTransition({ baselineTokens: 100, candidateTokens: 80,
    readRate: 0.5, writeRate: 1.25, warmRatio: 0.5, rewriteRatio: 0.25, horizon: 1,
    preservedPrefixTokens: 40 });
  assert.equal(g.accept, true);
  assert.equal(g.baseline_cost, 115);
  assert.equal(g.candidate_cost, 103);
  for (const preservedPrefixTokens of [-1, NaN, Infinity, '40', null])
    assert.equal(evaluateCacheTransition({ ...costs, preservedPrefixTokens }).reason, 'invalid_estimate');
});
test('legacy digest stays exact while summary versions and client roots isolate live and restored state', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const legacy = { ...context, historyMode: undefined };
  const old = approved(p, legacy);
  const expected = createHash('sha256').update(
    `${context.model}\0${context.route}\0${context.sessionKey}`).digest('hex').slice(0, 24);
  assert.equal(old.gpt_cache_gate.session, expected);
  assert.equal(old.gpt_cache_gate.history_mode, 'legacy');
  assert.equal(p.forRequest({ ...legacy, historyMode: 'legacy' }).cacheGate.heldCutoff, 100);
  const summary = approved(p);
  const rootA = approved(p, { ...context, sourceKey: 'private-client-root-A' });
  const rootB = approved(p, { ...context, sourceKey: 'private-client-root-B' });
  const gates = [old, summary, rootA, rootB].map(e => e.gpt_cache_gate);
  assert.equal(new Set(gates.map(g => g.session)).size, 4);
  assert.equal(summary.gpt_cache_gate.history_mode, 'summary');
  assert.ok(!JSON.stringify(gates).includes('private-client-root'));
  const seeds = [old, summary, rootA];
  const q = createGptCachePolicy({ now: () => 2, events: seeds });
  assert.equal(q.forRequest(legacy).cacheGate.heldCutoff, 100);
  assert.equal(q.forRequest(context).cacheGate.heldCutoff, 100);
  assert.equal(q.forRequest({ ...context, sourceKey: 'private-client-root-A' }).cacheGate.heldCutoff, 100);
  assert.equal(q.forRequest({ ...context, sourceKey: 'private-client-root-B' }).cacheGate.heldCutoff, undefined);
  assert.equal(q.forRequest({ ...legacy, sourceKey: 'private-client-root-A' }).cacheGate.heldCutoff, undefined);
});
test('summary reasoning checkpoints cannot override rejected economics or invent opaque savings', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const gate = p.forRequest(context).cacheGate;
  const plain = gate.evaluate(advance);
  assert.equal(plain.accept, false);
  assert.equal(plain.reason, 'cache_payback');
  assert.equal(plain.calibration_offset, 99_900);
  const g = gate.evaluate({ ...advance, summaryMode: true, reasoningRemoved: 3 });
  assert.deepEqual(g, plain); // Opaque retirement does not change costs or approval.
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'cache_payback');
  assert.equal(g.chosen_cutoff, 100);
  assert.equal(g.candidate_tokens, 99_980);
  assert.equal(g.selected_local_tokens, 100);
  assert.deepEqual(g.chosen_options, planning);
  assert.ok(g.candidate_cost > g.baseline_cost);
  // Equal/larger summaries are not token gains, regardless of opaque retirement.
  for (const candidateTokens of [100, 110]) {
    const noTextGain = gate.evaluate({ ...advance, candidateTokens,
      summaryMode: true, reasoningRemoved: 1 });
    assert.equal(noTextGain.accept, false);
    assert.equal(noTextGain.reason, 'no_token_gain');
    assert.equal(noTextGain.chosen_cutoff, 100);
    assert.equal(noTextGain.calibration_offset, 99_900);
  }
});
test('summary reasoning pruning commits only when the normal economic gate accepts', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p, context, { input: 100, cached: 90 });
  const request = p.forRequest(context);
  const args = { ...advance, preservedPrefixTokens: 80, options: planning };
  const economic = request.cacheGate.evaluate(args);
  const g = request.cacheGate.evaluate({ ...args, summaryMode: true, reasoningRemoved: 3 });
  assert.deepEqual(g, economic);
  assert.equal(g.accept, true);
  assert.equal(g.reason, 'cache_payback_met');
  assert.equal(g.chosen_cutoff, 200);
  assert.ok(g.candidate_cost < g.baseline_cost);
  request.record({ ...event('profitable', 80, 80), gpt_cache_gate: g });
  assert.equal(p.forRequest(context).cacheGate.heldCutoff, 200);
});
test('text-only, ineligible, legacy, and nonadvancing candidates never receive a reasoning override', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const gate = p.forRequest(context).cacheGate;
  for (const extra of [
    { summaryMode: true, reasoningRemoved: 0 },
    { summaryMode: false, reasoningRemoved: 1 },
    { reasoningRemoved: 1 },
    { summaryMode: true, reasoningRemoved: 1, candidateCutoff: 50 },
  ]) {
    const g = gate.evaluate({ ...advance, ...extra });
    assert.equal(g.accept, false);
    assert.equal(g.reason, 'cache_payback');
  }
  const same = gate.evaluate({ ...advance, candidateCutoff: 100,
    summaryMode: true, reasoningRemoved: 1 });
  assert.equal(same.reason, 'same_epoch_or_wire');
  const legacy = { ...context, historyMode: undefined };
  approved(p, legacy);
  const g = p.forRequest(legacy).cacheGate.evaluate({ ...advance, summaryMode: true, reasoningRemoved: 1 });
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'cache_payback');
});
test('invalid local estimates cannot be hidden by opaque offsets or forced at summary checkpoints', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const gate = p.forRequest(context).cacheGate;
  const invalid = [
    ...[NaN, Infinity, -1, 0, undefined].map(baselineTokens => ({ baselineTokens })),
    ...[NaN, Infinity, -1, undefined].map(candidateTokens => ({ candidateTokens })),
    ...[NaN, Infinity, -1, null, '10'].map(preservedPrefixTokens => ({ preservedPrefixTokens })),
    ...[NaN, Infinity, -1, 1.5].map(candidateCutoff => ({ candidateCutoff })),
    ...[NaN, Infinity, -1, 0.5].map(reasoningRemoved => ({ reasoningRemoved })),
    { profile: { cacheReadRate: 0 } }, { profile: { cacheReadRate: 0.1, cacheWriteRate: NaN } },
  ];
  for (const extra of invalid) {
    const g = gate.evaluate({ ...advance, summaryMode: true, reasoningRemoved: 1, ...extra });
    assert.equal(g.accept, false, JSON.stringify(extra));
    assert.equal(g.reason, 'invalid_estimate');
    assert.equal(g.chosen_cutoff, 100);
  }
  for (const extra of [{ sameWire: true }, { candidateCutoff: 100 }]) {
    const g = gate.evaluate({ ...advance, candidateTokens: NaN, ...extra });
    assert.equal(g.accept, false);
    assert.equal(g.reason, 'invalid_estimate');
  }
});
test('controller bounds preserved credit by visible estimates and last cached usage, never opaque offsets', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const g = p.forRequest(context).cacheGate.evaluate({ ...advance, preservedPrefixTokens: 1e9,
    opaquePrefixChanged: true });
  assert.equal(g.preserved_prefix_tokens, 80); // Not 99,980 including the unknown offset.
  assert.equal(g.history_mode, 'summary');
  assert.equal(g.calibration_offset, 99_900);
  const cold = createGptCachePolicy({ now: () => 1 });
  const first = cold.forRequest(context).cacheGate.evaluate({ ...advance, preservedPrefixTokens: 100 });
  assert.equal(first.preserved_prefix_tokens, 0);
  for (const cached of [0, undefined, NaN, -1]) {
    const q = createGptCachePolicy({ now: () => 1 });
    approved(q, context, { input: 1000, cached });
    assert.equal(q.forRequest(context).cacheGate.evaluate({
      ...advance, preservedPrefixTokens: 100 }).preserved_prefix_tokens, 0);
  }
  const scaled = createGptCachePolicy({ now: () => 1 });
  approved(scaled, context, { input: 50, cached: 20 });
  const args = { ...advance, baselineTokens: 200, candidateTokens: 180, preservedPrefixTokens: 1000 };
  assert.equal(scaled.forRequest(context).cacheGate.evaluate(args).preserved_prefix_tokens, 20);
  const seed = approved(createGptCachePolicy({ now: () => 1 }), context, { input: 50, cached: 20 });
  const restored = createGptCachePolicy({ now: () => 2, events: [seed] });
  assert.equal(restored.forRequest(context).cacheGate.evaluate(args).preserved_prefix_tokens, 20);
});
test('same-epoch replay freezes summary options and native tail floors, including after restart', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const seed = approved(p);
  const check = q => {
    const request = q.forRequest(context);
    assert.deepEqual(request.cacheGate.heldOptions, planning);
    request.cacheGate.heldOptions.keepTail = 1; // Exposing options must not mutate the committed seed.
    const g = request.cacheGate.evaluate({ ...advance, candidateCutoff: 100,
      options: { ...planning, keepTail: 80, sectionTokens: 5000, reasoningMode: 'other' } });
    assert.equal(g.accept, true);
    assert.deepEqual(g.chosen_options, planning);
    assert.equal(g.history_mode, 'summary');
    request.record({ ...event('same', 100_000, 90_000), gpt_cache_gate: g });
    assert.deepEqual(q.forRequest(context).cacheGate.heldOptions, planning);
  };
  check(p);
  check(createGptCachePolicy({ now: () => 2, events: [seed] }));
  const request = p.forRequest(context);
  const options = { ...planning, keepTail: 45 };
  const g = request.cacheGate.evaluate({ ...advance, baselineTokens: 2_000_000,
    candidateTokens: 1000, options, summaryMode: true, reasoningRemoved: 1 });
  assert.equal(g.accept, true);
  assert.equal(g.reason, 'cache_payback_met');
  assert.deepEqual(g.chosen_options, options); // Core may select a different floor at a NEW epoch.
});
test('same cutoff cannot bypass economics for projection version 2 over a held legacy version 1', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const request = p.forRequest(context);
  const g = request.cacheGate.evaluate({ ...advance, candidateCutoff: 100,
    options: { ...planning, projectionVersion: 2 }, sameWire: false });
  assert.equal(g.accept, false);
  assert.equal(g.reason, 'cache_payback');
  assert.equal(g.chosen_cutoff, 100);
  assert.deepEqual(g.chosen_options, planning);
  assert.equal(g.selected_local_tokens, 100);
  request.record({ ...event('held-version', 100_000, 90_000), gpt_cache_gate: g });
  assert.deepEqual(p.forRequest(context).cacheGate.heldOptions, planning);
});
test('profitable same-cutoff projection upgrade persists version 2 and restores it after restart', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const request = p.forRequest(context);
  const options = { ...planning, projectionVersion: 2 };
  const g = request.cacheGate.evaluate({ ...advance, baselineTokens: 2_000_000,
    candidateTokens: 1000, candidateCutoff: 100, options, sameWire: false });
  assert.equal(g.accept, true);
  assert.equal(g.reason, 'cache_payback_met');
  assert.deepEqual(g.chosen_options, options);
  const seed = { ...event('version-2', 1000, 950),
    ts: new Date(1).toISOString(), gpt_cache_gate: g };
  request.record(seed);
  for (const q of [p, createGptCachePolicy({ now: () => 2, events: [seed] })]) {
    const held = q.forRequest(context).cacheGate;
    assert.equal(held.heldCutoff, 100);
    assert.deepEqual(held.heldOptions, options);
    const replay = held.evaluate({ ...advance, candidateCutoff: 100,
      options: { ...options, keepTail: 80 } });
    assert.equal(replay.accept, true);
    assert.equal(replay.reason, 'same_epoch_or_wire');
    assert.deepEqual(replay.chosen_options, options);
    const downgrade = held.evaluate({ ...advance, candidateCutoff: 100, options: planning });
    assert.equal(downgrade.accept, false);
    assert.equal(downgrade.reason, 'cache_payback');
    assert.deepEqual(downgrade.chosen_options, options);
  }
});
test('same-wire projection migration remains free and missing projection version means 1', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  const gate = p.forRequest(context).cacheGate;
  const explicitLegacy = gate.evaluate({ ...advance, candidateCutoff: 100,
    options: { ...planning, projectionVersion: 1 }, sameWire: false });
  assert.equal(explicitLegacy.accept, true);
  assert.equal(explicitLegacy.reason, 'same_epoch_or_wire');
  assert.deepEqual(explicitLegacy.chosen_options, planning);
  const options = { ...planning, projectionVersion: 2 };
  const unchanged = gate.evaluate({ ...advance, candidateCutoff: 100, options, sameWire: true });
  assert.equal(unchanged.accept, true);
  assert.equal(unchanged.reason, 'same_epoch_or_wire');
  assert.deepEqual(unchanged.chosen_options, options);
  const explicit = createGptCachePolicy({ now: () => 1 });
  const legacyOptions = { ...planning, projectionVersion: 1 };
  approved(explicit, context, { options: legacyOptions });
  const missingCandidate = explicit.forRequest(context).cacheGate.evaluate({
    ...advance, candidateCutoff: 100, options: planning, sameWire: false });
  assert.equal(missingCandidate.accept, true);
  assert.equal(missingCandidate.reason, 'same_epoch_or_wire');
  assert.deepEqual(missingCandidate.chosen_options, legacyOptions);
});
test('summary restart ordering, client-root isolation, and evidence TTL survive profitable checkpoints', () => {
  let now = 1;
  const ctx = { ...context, sourceKey: 'root' };
  const p = createGptCachePolicy({ now: () => now, ttlMs: 100 });
  const old = approved(p, ctx);
  const request = p.forRequest(ctx);
  const g = request.cacheGate.evaluate({ ...advance, baselineTokens: 2_000_000,
    candidateTokens: 200_000, options: planning, summaryMode: true, reasoningRemoved: 2 });
  assert.equal(g.accept, true);
  assert.equal(g.reason, 'cache_payback_met');
  request.record({ ...event('new', 200_000, 25), gpt_cache_gate: g });
  const seed = { ...event('new', 200_000, 25), ts: new Date(1).toISOString(), gpt_cache_gate: g };
  const q = createGptCachePolicy({ now: () => now, ttlMs: 100, events: [seed, old] });
  const restored = q.forRequest(ctx);
  assert.equal(restored.cacheGate.heldCutoff, 200);
  const next = restored.cacheGate.evaluate({ ...advance, baselineTokens: 200_000,
    candidateTokens: 1000, candidateCutoff: 300,
    preservedPrefixTokens: 100, options: planning, summaryMode: true, reasoningRemoved: 1 });
  assert.equal(next.accept, true);
  assert.equal(next.reason, 'cache_payback_met');
  assert.equal(next.preserved_prefix_tokens, 25);
  assert.ok(next.request_seq > g.request_seq); // Same-millisecond restart must not look older.
  restored.record({ ...event('next', 200_000, 25), gpt_cache_gate: next });
  assert.equal(q.forRequest(ctx).cacheGate.heldCutoff, 300);
  assert.equal(q.forRequest({ ...ctx, sourceKey: 'reset-root' }).cacheGate.heldCutoff, undefined);
  now = 102;
  assert.equal(q.forRequest(ctx).cacheGate.heldCutoff, undefined);
  const future = createGptCachePolicy({ now: () => 0, events: [seed] });
  assert.equal(future.forRequest(ctx).cacheGate.heldCutoff, undefined);
});
test('late summary completions do not replace newer cached-prefix evidence', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p, context, { input: 100, cached: 100 });
  const a = p.forRequest(context), b = p.forRequest(context);
  const args = { ...advance, candidateTokens: 10, options: planning, summaryMode: true, reasoningRemoved: 1 };
  const ga = a.cacheGate.evaluate(args), gb = b.cacheGate.evaluate(args);
  assert.equal(ga.accept, true);
  assert.equal(gb.accept, true);
  b.record({ ...event('new', 100, 20), gpt_cache_gate: gb });
  a.record({ ...event('old', 100, 100), gpt_cache_gate: ga });
  const g = p.forRequest(context).cacheGate.evaluate({ ...advance,
    candidateCutoff: 300, preservedPrefixTokens: 100 });
  assert.equal(g.preserved_prefix_tokens, 20);
});
test('only safe planning values and numeric diagnostics are retained, not raw event payloads', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const request = p.forRequest(context);
  const g = request.cacheGate.evaluate({ ...advance, baselineTokens: 1000, candidateTokens: 100, options: { ...planning,
    cols: 'private prompt', maxHeightPx: Infinity, ignored: 'opaque ciphertext', messages: ['secret'] } });
  assert.deepEqual(g.chosen_options, planning);
  const raw = { ...event('raw', 1000, 20), ts: new Date(1).toISOString(), gpt_cache_gate: g };
  for (const key of ['prompt', 'ciphertext', 'images', 'body'])
    Object.defineProperty(raw, key, { enumerable: true, get() { throw new Error(`read raw ${key}`); } });
  assert.doesNotThrow(() => request.record(raw));
  const restored = createGptCachePolicy({ now: () => 2, events: [raw] });
  raw.gpt_cache_gate.chosen_options.keepTail = 999;
  assert.deepEqual(restored.forRequest(context).cacheGate.heldOptions, planning);
});
test('native-wire fallback cannot commit an epoch, calibrate costs, or refresh evidence TTL', () => {
  let now = 1;
  const p = createGptCachePolicy({ now: () => now, ttlMs: 100 });
  const request = p.forRequest(context);
  const first = request.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 1000,
    candidateTokens: 100, options: planning, profile });
  request.record({ ...event('fallback', 500_000, 400_000),
    gpt_cache_gate: { ...first, wire_applied: false } });
  const untouched = p.forRequest(context);
  assert.equal(untouched.cacheGate.heldCutoff, undefined);
  const g = untouched.cacheGate.evaluate({ ...advance, preservedPrefixTokens: 100 });
  assert.equal(g.calibration_offset, 0);
  assert.equal(g.preserved_prefix_tokens, 0);
  approved(p);
  now = 99;
  const held = p.forRequest(context);
  const next = held.cacheGate.evaluate({ ...advance, summaryMode: true, reasoningRemoved: 1 });
  held.record({ ...event('fallback', 500_000, 400_000),
    gpt_cache_gate: { ...next, wire_applied: false } });
  const still = p.forRequest(context);
  assert.equal(still.cacheGate.heldCutoff, 100);
  assert.equal(still.cacheGate.evaluate(advance).calibration_offset, 99_900);
  now = 102;
  assert.equal(p.forRequest(context).cacheGate.heldCutoff, undefined);
  const seed = { ...event('fallback'), ts: new Date(1).toISOString(),
    gpt_cache_gate: { ...first, wire_applied: false } };
  assert.equal(createGptCachePolicy({ now: () => 2, events: [seed] })
    .forRequest(context).cacheGate.heldCutoff, undefined);
});
test('outer-launcher GPT aliases and o-digit models get isolated controllers and statistics', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  for (const model of ['gpt-6.1-sol', 'openai/gpt-6.1-sol', 'o3', 'openai/o4-mini']) {
    const ctx = { ...context, model };
    const request = p.forRequest(ctx);
    assert.ok(request, model);
    const g = request.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 1000,
      candidateTokens: 100, options: planning, profile });
    request.record({ ...event('alias', 1000, 900, { model }), gpt_cache_gate: g });
    assert.equal(p.forRequest(ctx).cacheGate.heldCutoff, 100);
    assert.equal(g.history_mode, 'summary');
  }
  assert.equal(p.forRequest({ ...context, model: 'claude-test' }), null);
  const stats = analyzeGptCacheEvents([
    event('a', 1000, 900, { model: 'openai/o3' }),
    event('a', 1000, 900, { model: 'openai/o3' }),
  ]);
  assert.equal(stats['openai/o3|/v1/responses'].stable_samples, 1);
});
test('closed-prefix observability uses live getters and restores only numeric/hash seed values', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  const request = p.forRequest(context);
  assert.equal(typeof Object.getOwnPropertyDescriptor(request.cacheGate, 'heldClosedThrough')?.get, 'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(request.cacheGate, 'heldSignature')?.get, 'function');
  assert.equal(request.cacheGate.heldClosedThrough, undefined);
  assert.equal(request.cacheGate.heldSignature, undefined);
  const g = request.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 1000,
    candidateTokens: 100, options: planning, profile });
  const signature = 'ab'.repeat(32);
  const report = { ...g, closed_through: 130, closed_prefix_signature: signature };
  const seed = { ...event('closed', 1000, 900), ts: new Date(1).toISOString(), gpt_cache_gate: report };
  request.record(seed);
  assert.equal(request.cacheGate.heldClosedThrough, 130);
  assert.equal(request.cacheGate.heldSignature, signature);
  const q = createGptCachePolicy({ now: () => 2, events: [seed] });
  report.closed_through = 999;
  report.closed_prefix_signature = 'cd'.repeat(32);
  const restored = q.forRequest(context).cacheGate;
  assert.equal(restored.heldClosedThrough, 130);
  assert.equal(restored.heldSignature, signature);
  assert.deepEqual(restored.heldOptions, planning);
  const missing = { ...seed, gpt_cache_gate: { ...g } };
  const old = createGptCachePolicy({ now: () => 2, events: [missing] }).forRequest(context).cacheGate;
  assert.equal(old.heldClosedThrough, undefined);
  assert.equal(old.heldSignature, undefined);
});
test('failed, fallback, and older completions cannot change the closed-prefix witness', () => {
  let now = 1;
  const p = createGptCachePolicy({ now: () => now, ttlMs: 100 });
  approved(p);
  const a = p.forRequest(context), b = p.forRequest(context);
  const args = { ...advance, baselineTokens: 1_000_000, candidateTokens: 1000,
    options: planning, summaryMode: true, reasoningRemoved: 1 };
  const ga = { ...a.cacheGate.evaluate(args), closed_through: 210, closed_prefix_signature: 'aa'.repeat(16) };
  const gb = { ...b.cacheGate.evaluate(args), closed_through: 220, closed_prefix_signature: 'bb'.repeat(16) };
  assert.equal(ga.accept, true);
  assert.equal(gb.accept, true);
  b.record({ ...event('new'), gpt_cache_gate: gb });
  a.record({ ...event('old'), gpt_cache_gate: ga });
  const fresh = p.forRequest(context);
  assert.equal(fresh.cacheGate.heldClosedThrough, 220);
  assert.equal(fresh.cacheGate.heldSignature, 'bb'.repeat(16));
  const next = { ...fresh.cacheGate.evaluate({ ...args, candidateCutoff: 300 }),
    closed_through: 330, closed_prefix_signature: 'cc'.repeat(16) };
  assert.equal(next.accept, true);
  fresh.record({ ...event('fallback'), gpt_cache_gate: { ...next, wire_applied: false } });
  fresh.record({ ...event('failed'), status: 400, gpt_cache_gate: next });
  assert.equal(p.forRequest(context).cacheGate.heldClosedThrough, 220);
  assert.equal(p.forRequest(context).cacheGate.heldSignature, 'bb'.repeat(16));
  const seeds = [gb, ga].map(g => ({ ...event('closed'), ts: new Date(1).toISOString(), gpt_cache_gate: g }));
  const q = createGptCachePolicy({ now: () => now, ttlMs: 100, events: seeds });
  assert.equal(q.forRequest(context).cacheGate.heldClosedThrough, 220);
  assert.equal(q.forRequest(context).cacheGate.heldSignature, 'bb'.repeat(16));
  now = 102;
  assert.equal(q.forRequest(context).cacheGate.heldClosedThrough, undefined);
  assert.equal(q.forRequest(context).cacheGate.heldSignature, undefined);
});
test('closed-prefix metadata never retains nonnumeric cutoffs or raw content as a signature', () => {
  const p = createGptCachePolicy({ now: () => 1 });
  approved(p);
  for (const closed_through of [-1, NaN, Infinity, 1.5, 'raw state']) {
    const request = p.forRequest(context);
    const g = request.cacheGate.evaluate({ ...advance, candidateCutoff: 100 });
    const report = { ...g, closed_through, closed_prefix_signature: 'not a hash: private prompt/ciphertext' };
    request.record({ ...event('invalid-metadata'), gpt_cache_gate: report });
    const gate = p.forRequest(context).cacheGate;
    assert.equal(gate.heldClosedThrough, undefined);
    assert.equal(gate.heldSignature, undefined);
    const q = createGptCachePolicy({ now: () => 2, events: [
      { ...event('invalid-metadata'), ts: new Date(1).toISOString(), gpt_cache_gate: report },
    ] });
    assert.equal(q.forRequest(context).cacheGate.heldClosedThrough, undefined);
    assert.equal(q.forRequest(context).cacheGate.heldSignature, undefined);
  }
});

test('provider-observed context above 180k overrides economics once, then freezes the accepted epoch', () => {
  const p = createGptCachePolicy({ contextBudgetTokens: 180000 });
  const ctx = { sessionKey: 'context-budget', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1.25 };
  const first = p.forRequest(ctx);
  const boot = first.cacheGate.evaluate({ candidateCutoff: 50, baselineTokens: 400000,
    candidateTokens: 300000, options: { projectionVersion: 1 }, profile });
  first.record({ ...event('old', 310000, 300000), gpt_cache_gate: boot });
  const req = p.forRequest(ctx);
  const next = req.cacheGate.evaluate({ candidateCutoff: 100, baselineTokens: 300000,
    candidateTokens: 180000, options: { projectionVersion: 3 }, profile,
    reasoningRemoved: 20, summaryMode: true });
  assert.equal(next.accept, true);
  assert.equal(next.reason, 'context_budget');
  assert.equal(next.economic_accept, false);
  assert.equal(next.context_tokens, 310000);
  assert.equal(next.context_budget_tokens, 180000);
  assert.equal(next.chosen_cutoff, 100);
  req.record({ ...event('new', 170000, 0), gpt_cache_gate: next });
  const repeat = p.forRequest(ctx).cacheGate.evaluate({ candidateCutoff: 100,
    baselineTokens: 180000, candidateTokens: 180000,
    options: { projectionVersion: 3 }, sameWire: true, profile });
  assert.equal(repeat.reason, 'same_epoch_or_wire');
  assert.notEqual(repeat.budget_forced, true);
  const small = p.forRequest(ctx).cacheGate.evaluate({ candidateCutoff: 150,
    baselineTokens: 180000, candidateTokens: 179000,
    options: { projectionVersion: 3 }, profile });
  assert.equal(small.accept, false, 'do not rewrite the cache for a tiny context gain');
});

test('context guard respects disable/invalid estimates and cannot manufacture token savings', () => {
  for (const contextBudgetTokens of [0, 180000]) {
    const p = createGptCachePolicy({ contextBudgetTokens });
    const req = p.forRequest({ sessionKey: `budget-${contextBudgetTokens}`, model: 'gpt-6.1-sol',
      route: '/v1/responses', historyMode: 'summary' });
    const profile = { cacheReadRate: 0.1, cacheWriteRate: 1.25 };
    const boot = req.cacheGate.evaluate({ candidateCutoff: 50,
      baselineTokens: 400000, candidateTokens: 100000, profile });
    req.record({ ...event('a', 310000, 300000), gpt_cache_gate: boot });
    const g = p.forRequest({ sessionKey: `budget-${contextBudgetTokens}`, model: 'gpt-6.1-sol',
      route: '/v1/responses', historyMode: 'summary' }).cacheGate;
    const flat = g.evaluate({ candidateCutoff: 100, baselineTokens: 100000,
      candidateTokens: 100000, profile });
    assert.equal(flat.accept, false);
    assert.equal(g.evaluate({ candidateCutoff: 100, baselineTokens: NaN,
      candidateTokens: 1000, profile }).reason, 'invalid_estimate');
    assert.equal(g.evaluate({ candidateCutoff: 100, baselineTokens: 100000,
      candidateTokens: 1000, profile: { ...profile, cacheReadRate: 0 } }).reason, 'invalid_estimate');
    if (contextBudgetTokens === 0) assert.equal(g.evaluate({ candidateCutoff: 100,
      baselineTokens: 100000, candidateTokens: 99000, profile }).accept, false);
  }
});

test('over-budget opaque-only retirement requires a substantial state reduction, not ten blobs each epoch', () => {
  const p = createGptCachePolicy({ contextBudgetTokens: 180000 });
  const ctx = { sessionKey: 'opaque-budget', model: 'gpt-6.1-sol',
    route: '/v1/responses', historyMode: 'summary' };
  const profile = { cacheReadRate: 0.1, cacheWriteRate: 1.25 };
  const req = p.forRequest(ctx);
  const seed = req.cacheGate.evaluate({ candidateCutoff: 50, baselineTokens: 100000,
    candidateTokens: 10000, options: { projectionVersion: 3 }, profile });
  req.record({ ...event('opaque', 300000, 290000), gpt_cache_gate: seed });
  const gate = p.forRequest(ctx).cacheGate;
  const candidate = { candidateCutoff: 100, baselineTokens: 10000, candidateTokens: 10000,
    baselineOpaqueItems: 100, options: { projectionVersion: 3 }, profile };
  assert.equal(gate.evaluate({ ...candidate, candidateOpaqueItems: 90, reasoningRemoved: 10 }).accept, false);
  const large = gate.evaluate({ ...candidate, candidateOpaqueItems: 30, reasoningRemoved: 70 });
  assert.equal(large.reason, 'context_budget');
  assert.equal(large.unknown_reasoning_savings, true);
  assert.equal(large.baseline_tokens, 300000);
  assert.equal(large.candidate_tokens, 300000, 'do not invent a ciphertext token benefit');
});
