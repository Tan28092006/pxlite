import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { withEnv } from './lib-test-env.mjs';
import { createGptCachePolicy } from './gpt-cache-policy.mjs';
import { transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';
import { readNoteText, appendReadNote } from './vendor/pxpipe-proxy/dist/core/transform.js';
const enc = x => new TextEncoder().encode(JSON.stringify(x));
const dec = x => JSON.parse(new TextDecoder().decode(x));
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fixture = n => ({ model: 'gpt-6.1-sol', input: [
  { role: 'user', content: 'Inspect C:/project/main.js, implement the fix and verify tests.' },
  ...Array.from({ length: n }, (_, i) => [
    { type: 'reasoning', id: `r${i}`, encrypted_content: `OPAQUE_SECRET_${i}`,
      summary: [{ type: 'summary_text', text: `PUBLIC_STEP_${i}: verify the implementation against the completed checks.` }] },
    { role: 'assistant', content: `Inspect step ${i}. ` + 'Preserve test evidence and outstanding decisions. '.repeat(20) },
    { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: JSON.stringify({ command: `node check-${i}.mjs` }) },
    { type: 'function_call_output', call_id: `c${i}`, output: 'Build passed.\n'.repeat(80) },
  ]).flat(),
] });
const opts = { reasoningMode: 'summary', checkpointChunk: 50, keepTail: 30,
  keepRecentPairs: 0, maxImages: 160, sectionTokens: 900, minCollapseTokens: 0,
  minCollapsePrefix: 0, preserveClientImages: true };
const env = { PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0,
  PXLITE_READ_NOTE: 0 };
const accept = heldCutoff => ({ heldCutoff, evaluate: x => ({ accept: true,
  history_mode: 'summary', chosen_cutoff: x.candidateCutoff }) });
const history = b => b.input.filter(x => x.content?.some?.(p =>
  p.type === 'input_text' && p.text?.startsWith('[Earlier turns in image(s):')));
const run = (b, gate = accept()) => transformOpenAIResponses(enc(b),
  { gptHistory: { ...opts, cacheGate: gate } });

test('50-to-130 migration replays old pages and waits a full 130 source items from the held cutoff', () => withEnv(env, async () => {
  const first = await run(fixture(45));
  assert.equal(first.info.gptCacheGate.chosen_cutoff, 150);
  const original = dec(first.body);
  let offered;
  const gate = { heldCutoff: 150, heldOptions: { ...opts, projectionVersion: 5 },
    evaluate: args => {
      offered = args;
      return { accept: false, reason: 'cache_payback', chosen_cutoff: 150 };
    } };
  const next = await transformOpenAIResponses(enc(fixture(60)),
    { gptHistory: { ...opts, checkpointChunk: 130, cacheGate: gate } });
  assert.equal(offered.candidateCutoff, 150);
  assert.equal(offered.options.checkpointChunk, 50);
  assert.deepEqual(dec(next.body).input.slice(0, original.input.length), original.input);
  const later = await transformOpenAIResponses(enc(fixture(80)),
    { gptHistory: { ...opts, checkpointChunk: 130, cacheGate: gate } });
  assert.equal(offered.candidateCutoff, 280, 'not 260: migration is anchored at the committed 150');
  assert.equal(offered.options.checkpointChunk, 130);
  assert.ok(offered.savedTextChars >= 40000);
  assert.deepEqual(dec(later.body).input.slice(0, original.input.length), original.input);
}));

const readFixture = n => ({ model: 'gpt-6.1-sol', input: [
  { role: 'user', content: 'Inspect the relevant source ranges.' },
  ...Array.from({ length: n }, (_, i) => [
    { type: 'function_call', call_id: `read${i}`, name: 'read',
      arguments: JSON.stringify({ path: `C:/project/source-${i}.js`, offset: i * 25, limit: 25 }) },
    { type: 'function_call_output', call_id: `read${i}`, output: 'Source line with ordinary implementation details.\n'.repeat(30) },
  ]).flat(),
] });
const readOptions = { ...opts, minCollapseTokens: 30000, projectionVersion: 4 };
test('v4 archives small old Read ranges without requiring a duplicate read; v3 replay stays identical', async () => {
  const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
  const b = readFixture(45), original = hash(b);
  const old = await H.planResponsesSummaryCollapse(b.input, () => true, { ...readOptions, projectionVersion: 3 });
  assert.equal(old.pairState.collapsedPairs, 0, 'fixture is below the old 30k floor');
  const p = await H.planResponsesSummaryCollapse(b.input, () => true, readOptions);
  assert.equal(p.pairState.collapsedPairs, 24);
  assert.match(p.text, /C:\/project\/source-0\.js.*offset=0.*limit=25/);
  assert.ok(!p.text.includes('Source line with ordinary'));
  assert.ok(p.selectedIndices.every(i => i < b.input.length - 30));
  assert.equal(hash(b), original);
  const appended = await H.planResponsesSummaryCollapse(readFixture(48).input, () => true, readOptions);
  assert.deepEqual(appended.selectedIndices, p.selectedIndices);
  assert.deepEqual(appended.imageSources, p.imageSources);
  const noPageProfit = await H.planResponsesSummaryCollapse(b.input, () => false, readOptions);
  assert.equal(noPageProfit.pairState.collapsedPairs, 24, 'old Read >200 chars does not wait for a per-page gate');
  assert.deepEqual(await H.planResponsesSummaryCollapse(b.input, () => true,
    { ...readOptions, projectionVersion: 3 }), old);
});

test('v4 Read breadcrumb retains its qualified tool name and exact locator', async () => {
  const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
  const b = readFixture(45);
  b.input[1].namespace = 'functions';
  const p = await H.planResponsesSummaryCollapse(b.input, () => true, readOptions);
  assert.match(p.text, /\[functions\.read\] "C:\/project\/source-0\.js" offset=0 limit=25/);
});

test('v4 relaxed Read rule preserves failures, missing paths, images and referenced results', async () => {
  const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
  for (const kind of ['failure', 'path', 'image', 'reference']) {
    const b = readFixture(45);
    if (kind === 'failure') b.input[2].output = 'Error: access denied.\n'.repeat(50);
    if (kind === 'path') b.input[1].arguments = '{"offset":0,"limit":25}';
    if (kind === 'image') b.input[2].output = [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }];
    if (kind === 'reference') {
      b.input[2].id = 'referenced-read';
      b.input.splice(3, 0, { type: 'item_reference', id: 'referenced-read' });
    }
    const p = await H.planResponsesSummaryCollapse(b.input, () => true, readOptions);
    assert.ok(!p.selectedIndices.includes(1) && !p.selectedIndices.includes(2), kind);
    assert.ok(p.pairState.collapsedPairs > 0, 'other recoverable reads still progress: ' + kind);
  }
});

test('v4 Read retirement uses a strict 200-character threshold, not token or range size', async () => {
  const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
  for (const length of [199, 200, 201]) {
    const b = readFixture(45);
    for (const item of b.input) if (item.type === 'function_call_output') item.output = 'x'.repeat(length);
    const p = await H.planResponsesSummaryCollapse(b.input, () => false, readOptions);
    assert.equal(p.pairState.collapsedPairs, length > 200 ? 24 : 0, `output chars=${length}`);
  }
});

test('rejected v4 Read migration replays the complete v3 wire instead of silently editing its prefix', () => withEnv(env, async () => {
  const b = readFixture(45);
  const before = await transformOpenAIResponses(enc(b), { gptHistory: {
    ...readOptions, projectionVersion: 3, cacheGate: accept() } });
  const cutoff = before.info.gptCacheGate.chosen_cutoff;
  const after = await transformOpenAIResponses(enc(b), { gptHistory: {
    ...readOptions, cacheGate: { heldCutoff: cutoff, heldOptions: { projectionVersion: 3 },
      evaluate: () => ({ accept: false, chosen_cutoff: cutoff, reason: 'cache_payback' }) } } });
  assert.deepEqual(dec(after.body), dec(before.body));
}));

test('summary wire removes old opaque state, renders public summaries, preserves >=30 source items', () => withEnv(env, async () => {
  const b = fixture(80), original = hash(b);
  const r = await run(b), out = dec(r.body);
  assert.ok(out.input.filter(x => x.type === 'reasoning').length < 50,
    'do not retain a separate historical reservoir of 50 encrypted reasoning items');
  assert.deepEqual(out.input.slice(-30), b.input.slice(-30));
  const sources = (r.info.imageSourceTexts ?? []).join('\n');
  assert.ok(sources.includes('PUBLIC_STEP_0'));
  assert.ok(!sources.includes('OPAQUE_SECRET_'));
  assert.equal(hash(b), original);
  assert.equal(r.info.gptCacheGate.history_mode, 'summary');
}));

test('realistic phased assistant messages archive completed tools instead of retaining every output', () => withEnv(env, async () => {
  const b = fixture(70);
  for (const item of b.input) if (item.role === 'assistant') {
    item.type = 'message';
    item.phase = 'commentary';
    item.content = [{ type: 'output_text', text: item.content, annotations: [] }];
  }
  const r = await run(b);
  const out = dec(r.body);
  assert.ok(out.input.filter(item => item.type === 'function_call_output').length <= 10,
    'only the safe live tail may retain the successful shell outputs');
  assert.ok(r.info.responsesComposition.collapsedFunctionPairs >= 60);
  const reasons = r.info.responsesComposition.nativeFunctionPairReasons;
  assert.deepEqual(Object.keys(reasons), ['live_tail']);
  assert.equal(Object.values(reasons).reduce((a, b) => a + b, 0),
    r.info.responsesComposition.completedFunctionPairs - r.info.responsesComposition.collapsedFunctionPairs);
  assert.match((r.info.imageSourceTexts ?? []).join('\n'), /phase="commentary"/);
  assert.deepEqual(out.input.slice(-30), b.input.slice(-30));
}));

test('rejected phase-projector migration preserves the exact old archive at the same cutoff', () => withEnv(env, async () => {
  const b = fixture(30);
  for (const item of b.input) if (item.role === 'assistant') item.phase = 'commentary';
  const old = await transformOpenAIResponses(enc(b), { gptHistory: {
    ...opts, projectionVersion: 1, cacheGate: accept() } });
  const reject = { heldCutoff: old.info.gptCacheGate.chosen_cutoff,
    heldOptions: { projectionVersion: 1 }, evaluate: () => ({
      accept: false, chosen_cutoff: old.info.gptCacheGate.chosen_cutoff, reason: 'cache_payback' }) };
  const held = await transformOpenAIResponses(enc(b),
    { gptHistory: { ...opts, projectionVersion: 2, cacheGate: reject } });
  assert.deepEqual(dec(held.body), dec(old.body),
    'a projector fix must not silently rebuild a previously committed archive');
  assert.equal(held.info.gptCacheGate.reason, 'cache_payback');
}));
test('append between checkpoints preserves exact outgoing prefix; a later checkpoint only appends sealed pages', () => withEnv(env, async () => {
  const a = dec((await run(fixture(30))).body);
  const b = dec((await run(fixture(32), accept(50))).body);
  assert.equal(hash(b.input.slice(0, a.input.length)), hash(a.input));
  const c = dec((await run(fixture(43), accept(50))).body);
  assert.ok(history(a).length > 0);
  assert.ok(history(c).length > history(a).length);
  assert.deepEqual(history(c).slice(0, history(a).length), history(a));
}));
test('a rejected text/history transition holds both previous pages and native reasoning', () => withEnv(env, async () => {
  const first = dec((await run(fixture(30))).body);
  const reject = { heldCutoff: 50, evaluate: () => ({ accept: false, history_mode: 'summary',
    chosen_cutoff: 50, reason: 'cache_payback' }) };
  const r = await run(fixture(43), reject);
  assert.equal(hash(dec(r.body).input.slice(0, first.input.length)), hash(first.input));
  assert.equal(r.info.gptCacheGate.reason, 'cache_payback');
}));
test('checkpoint positions are counted before synthetic static-slab insertion', () => withEnv(env, async () => {
  const b = fixture(30);
  b.instructions = 'Follow the implementation contract, preserve evidence, and check each regression. '.repeat(500);
  const r = await run(b);
  assert.ok(dec(r.body).input.some(x => x.content?.some?.(p => p.text === '[End of rendered GPT system/tool context.]')));
  assert.equal(r.info.gptCacheGate.candidate_cutoff, 50);
  assert.equal(r.info.gptCacheGate.source_items, b.input.length);
}));
test('legacy v4 keeps the old economic-only opaque retirement policy for replay', () => withEnv(env, async () => {
  const p = createGptCachePolicy();
  const request = p.forRequest({ sessionKey: 'summary-only', historyMode: 'summary',
    model: 'gpt-6.1-sol', route: '/v1/responses' });
  const b = { model: 'gpt-6.1-sol', input: [{ role: 'user', content: 'Continue the work.' },
    ...Array.from({ length: 120 }, (_, i) => ({
      type: 'reasoning', id: `s${i}`, summary: [], encrypted_content: `OPAQUE_ONLY_${i}` }))] };
  const r = await transformOpenAIResponses(enc(b), { gptHistory: {
    ...opts, projectionVersion: 4, cacheGate: request.cacheGate } });
  assert.deepEqual(dec(r.body), b);
  assert.equal(r.info.gptCacheGate.reasoning_removed, 0);
  assert.equal(r.info.gptCacheGate.chosen_cutoff, 0);
  assert.equal(r.info.gptCacheGate.reason, 'no_token_gain');
  assert.equal(r.info.imageCount, 0);
}));
test('v5 does not rewrite empty-summary state without economic gain below budget', () => withEnv(env, async () => {
  const policy = createGptCachePolicy({ contextBudgetTokens: 0 });
  const context = { sessionKey: 'v5-opaque-retention', historyMode: 'summary',
    model: 'gpt-6.1-sol', route: '/v1/responses' };
  const build = n => ({ model: context.model, input: [{ role: 'user', content: 'Continue.' },
    ...Array.from({ length: n }, (_, i) => ({
      type: 'reasoning', id: `empty${i}`, summary: [], encrypted_content: `OPAQUE_UNREADABLE_${i}` }))] });
  const request = policy.forRequest(context);
  const b = build(120), before = structuredClone(b);
  const r = await run(b, request.cacheGate), out = dec(r.body);
  assert.equal(r.info.gptCacheGate.reason, 'no_token_gain');
  assert.equal(r.info.gptCacheGate.accept, false);
  assert.equal(r.info.gptCacheGate.reasoning_removed, 0);
  assert.deepEqual(out, b, 'a rejected retirement preserves every native opaque item');
  assert.deepEqual(out.input.slice(-30), b.input.slice(-30));
  assert.equal(r.info.imageCount, 0, 'no fabricated summary or ciphertext image');
  assert.deepEqual(b, before);
  request.record({ model: context.model, path: context.route, status: 200,
    input_tokens: 10000, cached_tokens: 0, gpt_cache_gate: r.info.gptCacheGate });
  const next = await run(build(125), policy.forRequest(context).cacheGate);
  assert.deepEqual(dec(next.body).input.slice(0, out.input.length), out.input);
  assert.equal(next.info.gptCacheGate.chosen_cutoff, r.info.gptCacheGate.chosen_cutoff);
}));
test('late native references atomically fall back without committing a fictitious sealed epoch', () => withEnv(env, async () => {
  const policy = createGptCachePolicy();
  const context = { sessionKey: 'late-reference', historyMode: 'summary',
    model: 'gpt-6.1-sol', route: '/v1/responses' };
  const aRequest = policy.forRequest(context);
  const a = await run(fixture(30), aRequest.cacheGate);
  aRequest.record({ model: context.model, path: context.route, status: 200,
    input_tokens: 20000, cached_tokens: 18000, gpt_cache_gate: a.info.gptCacheGate });
  const oldCutoff = policy.forRequest(context).cacheGate.heldCutoff;
  const b = fixture(32);
  b.input.push({ type: 'item_reference', id: 'r0' });
  const request = policy.forRequest(context);
  const r = await run(b, request.cacheGate);
  assert.equal(r.info.gptCacheGate.reason, 'summary_native_reference');
  assert.equal(r.info.gptCacheGate.wire_applied, false);
  assert.deepEqual(dec(r.body), b);
  request.record({ model: context.model, path: context.route, status: 200,
    input_tokens: 50000, gpt_cache_gate: r.info.gptCacheGate });
  assert.equal(policy.forRequest(context).cacheGate.heldCutoff, oldCutoff);
}));
test('image-budget fail-safe retains native pixels and does not commit a partial archive', () => withEnv(env, async () => {
  const b = fixture(30);
  b.input[0].content = [{ type: 'input_text', text: 'Keep the screenshot evidence.' },
    { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxXcAAAAASUVORK5CYII=' }];
  const r = await transformOpenAIResponses(enc(b),
    { gptHistory: { ...opts, maxImages: 0, cacheGate: accept() } });
  assert.equal(r.info.gptCacheGate.reason, 'summary_image_budget');
  assert.equal(r.info.gptCacheGate.wire_applied, false);
  assert.deepEqual(dec(r.body), b);
}));
test('serialized native fallback never commits an unapplied summary plan', () => withEnv({
  ...env, PXPIPE_GPT_PROFILES: JSON.stringify({ 'gpt-6.1-sol': { maxSerializedRequestBytes: 1024 } }),
}, async () => {
  const policy = createGptCachePolicy();
  const context = { sessionKey: 'byte-fallback', historyMode: 'summary',
    model: 'gpt-6.1-sol', route: '/v1/responses' };
  const request = policy.forRequest(context);
  const b = fixture(30), r = await run(b, request.cacheGate);
  assert.equal(r.info.gptCacheGate.reason, 'serialized_request_limit');
  assert.equal(r.info.gptCacheGate.wire_applied, false);
  assert.deepEqual(dec(r.body), b);
  request.record({ model: context.model, path: context.route, status: 200,
    input_tokens: 40000, gpt_cache_gate: r.info.gptCacheGate });
  assert.equal(policy.forRequest(context).cacheGate.heldCutoff, undefined);
}));
test('retired image reminder leaves live suffix and archived envelopes unchanged', () => withEnv({
  ...env, PXLITE_READ_NOTE: undefined,
}, async () => {
  const r = await run(fixture(30));
  const out = dec(r.body);
  assert.equal(readNoteText(), '');
  assert.ok(!r.info.readNote);
  assert.deepEqual(out.input.at(-1), fixture(30).input.at(-1));
  assert.ok(!JSON.stringify(out).includes('Before answering, read every image'));
  const off = await withEnv({ PXLITE_READ_NOTE: 0 }, () => run(fixture(30)));
  assert.deepEqual(history(out), history(dec(off.body)));
  assert.deepEqual(dec(appendReadNote(r, 'responses').body), out);
  const next = dec((await run(fixture(43), accept(50))).body);
  assert.deepEqual(history(next).slice(0, history(out).length), history(out));
}));
