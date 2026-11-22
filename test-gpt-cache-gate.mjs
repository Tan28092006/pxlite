import assert from 'node:assert/strict';
import test from 'node:test';
import { withEnv } from './lib-test-env.mjs';
import { createGptCachePolicy } from './gpt-cache-policy.mjs';
const O = await import('./vendor/pxpipe-proxy/dist/core/openai.js');
const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
const encode = body => new TextEncoder().encode(JSON.stringify(body));
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
const body = n => ({ model: 'gpt-6.1-sol', input: [
  { role: 'user', content: 'Inspect C:/project/src/main.js and run tests.' },
  ...Array.from({ length: n }, (_, i) => [
    { type: 'reasoning', id: `rs_${i}`, summary: [], encrypted_content: `opaque-state-${i}` },
    { role: 'assistant', content: [{ type: 'output_text', text:
      `Inspect C:/project/${i}.js. ` + 'Compare implementation and preserve the evidence of the completed checks. '.repeat(90) }] },
    { type: 'function_call', call_id: `c${i}`, name: 'shell', arguments: JSON.stringify({ command: `node check-${i}.js` }) },
    { type: 'function_call_output', call_id: `c${i}`, output: 'All checks passed.\n'.repeat(30) },
  ]).flat(),
] });
const env = { PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_READ_NOTE: 0 };
const options = { checkpointChunk: 50, sectionTokens: 500, maxImages: 160,
  minCollapseTokens: 0, minCollapsePrefix: 0, preserveClientImages: true };

test('explicit approved checkpoint zero must not bootstrap or image any history', async () => {
  const p = await H.planResponsesPairCollapse(body(30).input, () => true,
    { ...options, checkpointCutoff: 0, checkpointBootstrap: true, responsesMode: 'mixed' });
  assert.deepEqual(p.selectedIndices, []);
  assert.equal(p.images.length, 0);
});
test('wire estimates never tokenize ciphertext as literal input tokens', () => {
  assert.equal(typeof O.estimateResponsesCacheTokens, 'function');
  const a = body(2);
  const b = structuredClone(a);
  b.input.find(x => x.type === 'reasoning').encrypted_content = 'secret-ciphertext-'.repeat(100_000);
  assert.equal(O.estimateResponsesCacheTokens(a).tokens, O.estimateResponsesCacheTokens(b).tokens);
  assert.equal(O.estimateResponsesCacheTokens(a).visibleTextChars,
    O.estimateResponsesCacheTokens(b).visibleTextChars);
  assert.equal(O.estimateResponsesCacheTokens(b).opaqueItems, 2);
});

test('an orphan output protects the preceding reasoning instead of pruning unresolved state', () => {
  const input = Array.from({ length: 80 }, (_, i) => ({ type: 'reasoning', id: `r${i}`, encrypted_content: `opaque${i}` }));
  input.splice(1, 0, { type: 'function_call_output', call_id: 'missing', output: 'orphan' });
  const p = H.responsesReasoningPrune(input, { cutoff: 70, frameEnd: 81, keep: 50 });
  assert.ok(!p.removed.includes(0));
  assert.ok(p.protected > 0);
});
test('an appended live-tail message cannot change the accepted history planning floors', () => withEnv({
  ...env, PXLITE_GPT_MIN_COLLAPSE_TOKENS: 180000, PXLITE_MIN_COLLAPSE_MESSAGES: 50,
}, async () => {
  const policy = createGptCachePolicy();
  const context = { sessionKey: 'forced-floor', model: 'gpt-6.1-sol', route: '/v1/responses' };
  const aRequest = policy.forRequest(context);
  const opts = { checkpointChunk: 50, preserveClientImages: true };
  const first = await O.transformOpenAIResponses(encode(body(18)),
    { gptHistory: { ...opts, cacheGate: aRequest.cacheGate } });
  aRequest.record({ model: context.model, path: context.route, status: 200,
    input_tokens: 20000, gpt_cache_gate: first.info.gptCacheGate });
  const b = body(18);
  b.input.push({ role: 'user', content: 'Inspect the current live task carefully. '.repeat(22000) });
  const next = await O.transformOpenAIResponses(encode(b),
    { gptHistory: { ...opts, cacheGate: policy.forRequest(context).cacheGate } });
  const old = decode(first.body).input;
  assert.deepEqual(decode(next.body).input.slice(0, old.length), old);
}));
test('a rejected epoch retains the complete previous image/native prefix and exact reasoning state', () => withEnv(env, async () => {
  const run = async (n, cacheGate) => O.transformOpenAIResponses(encode(body(n)),
    { gptHistory: { ...options, cacheGate } });
  const accept = { heldCutoff: undefined, evaluate: a => ({ accept: true, chosen_cutoff: a.candidateCutoff }) };
  const first = await run(18, accept);
  const old = decode(first.body);
  assert.ok(old.input.some(x => x.content?.some?.(p => p.type === 'input_image')));
  let offered;
  const reject = { heldCutoff: 50, evaluate: a => {
    offered = a;
    return { accept: false, reason: 'cache_payback', chosen_cutoff: 50 };
  } };
  const next = await run(31, reject);
  const after = decode(next.body);
  assert.ok(offered.candidateCutoff > 50);
  assert.ok(offered.baselineTokens > 0 && offered.candidateTokens > 0);
  assert.deepEqual(after.input.slice(0, old.input.length), old.input);
  assert.equal(next.info.gptCacheGate.reason, 'cache_payback');
  assert.deepEqual(after.input.filter(x => x.type === 'reasoning'),
    body(31).input.filter(x => x.type === 'reasoning'));
}));
test('managed cache policy preserves client image pixels instead of projecting them to [image]', () => withEnv(env, async () => {
  const b = body(30);
  const image = { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', detail: 'high' };
  b.input.splice(5, 0, { role: 'user', content: [{ type: 'input_text', text: 'Keep this evidence.' }, image] });
  b.input.splice(80, 0, { role: 'user', content: 'Continue with the next independent check.' });
  b.input.push({ role: 'user', content: 'Verify the final results.' });
  const p = createGptCachePolicy();
  const request = p.forRequest({ sessionKey: 'image-session', model: b.model, route: '/v1/responses' });
  const r = await O.transformOpenAIResponses(encode(b), { gptHistory: { ...options, cacheGate: request.cacheGate } });
  const images = decode(r.body).input.flatMap(x => Array.isArray(x.content) ? x.content : []).filter(x => x.type === 'input_image');
  assert.ok(images.some(x => x.image_url === image.image_url));
}));
test('reasoning cap is fixed at the accepted frame, not a sliding window on append', () => {
  assert.equal(typeof H.responsesReasoningPrune, 'function');
  const items = Array.from({ length: 90 }, (_, i) =>
    ({ type: 'reasoning', id: `r${i}`, encrypted_content: `opaque-${i}`, summary: [] }));
  const frame = { cutoff: 75, frameEnd: 80 };
  const a = H.responsesReasoningPrune(items, frame, 50);
  assert.deepEqual(a.removed, Array.from({ length: 30 }, (_, i) => i));
  assert.equal(a.kept, 50);
  assert.deepEqual(H.responsesReasoningPrune([...items, ...items.slice(0, 5)], frame, 50), a);
  items.push({ type: 'item_reference', id: 'r0' });
  const referenced = H.responsesReasoningPrune(items, frame, 50);
  assert.ok(!referenced.removed.includes(0));
  assert.equal(referenced.kept, 51);
});
test('reasoning belonging to open tool state overrides the historical cap', () => {
  const items = [{ type: 'reasoning', id: 'r0', encrypted_content: 'first-opaque' },
    { type: 'function_call', call_id: 'open', name: 'shell', arguments: '{}' },
    ...Array.from({ length: 70 }, (_, i) => ({ type: 'reasoning', id: `r${i + 1}`, encrypted_content: `opaque-${i}` }))];
  const p = H.responsesReasoningPrune(items, { cutoff: 70, frameEnd: items.length }, 50);
  assert.deepEqual(p.removed, []);
  assert.equal(p.protected, 71);
});
