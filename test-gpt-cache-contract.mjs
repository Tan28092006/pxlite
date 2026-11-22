// Cache contract: compare complete old messages, not just PNG hashes. No API calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { stripCacheBreakpoints } from './compat.mjs';
import { withEnv } from './lib-test-env.mjs';
import { createToolCollapse } from './collapse-tools.mjs';
const H = await import('./vendor/pxpipe-proxy/dist/core/openai-history.js');
const O = await import('./vendor/pxpipe-proxy/dist/core/openai.js');
const enc = x => new TextEncoder().encode(JSON.stringify(x));
const dec = x => JSON.parse(new TextDecoder().decode(x));
const marker = { mode: 'explicit' };
const request = () => ({
  model: 'gpt-6.1-sol',
  tools: [{ type: 'function', name: 'example', parameters: { type: 'object',
    properties: { prompt_cache_breakpoint: { type: 'string' } } } }],
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'stable', prompt_cache_breakpoint: marker }] }],
});

test('gpt-6.1-sol strips unsupported cache anchors on both API and Codex backends', () => {
  const body = enc(request());
  const api = dec(stripCacheBreakpoints(body, { url: 'https://api.openai.com/v1/responses' }));
  assert.ok(!api.input[0].content[0].prompt_cache_breakpoint);
  const codex = dec(stripCacheBreakpoints(body, { url: 'https://chatgpt.com/backend-api/codex/responses' }));
  assert.ok(!codex.input[0].content[0].prompt_cache_breakpoint);
});

test('cache compatibility never deletes a tool schema property with the same name', () => {
  const out = dec(stripCacheBreakpoints(enc(request()), { url: 'https://chatgpt.com/backend-api/codex/responses' }));
  assert.deepEqual(out.tools[0].parameters.properties.prompt_cache_breakpoint, { type: 'string' });
});

test('legacy API models strip unsupported anchors; unrelated upstreams are not rewritten', () => {
  const req = { ...request(), model: 'gpt-5.4' };
  const body = enc(req);
  assert.ok(!dec(stripCacheBreakpoints(body, { url: 'https://api.openai.com/v1/responses' })).input[0].content[0].prompt_cache_breakpoint);
  assert.deepEqual(stripCacheBreakpoints(body, { url: 'https://other.invalid/v1/responses' }), body);
});

test('an explicit-only caller must not silently become explicit mode with zero breakpoints', () => {
  const body = enc({ ...request(), prompt_cache_options: { mode: 'explicit', ttl: '30m' } });
  // Unsupported callers may get an upstream error; silently disabling caching is worse.
  assert.deepEqual(stripCacheBreakpoints(body, { url: 'https://chatgpt.com/backend-api/codex/responses' }), body);
});

function responses(n) {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect C:/project/src/main.js and run its tests.' }] }];
  for (let i = 0; i < n; i++) input.push(
    { type: 'reasoning', id: `rs_${i}`, summary: [], encrypted_content: `opaque-${i}` },
    { role: 'assistant', content: [{ type: 'output_text', text: `Inspect step ${i} and C:/project/check-${i}.js.` }] },
    { type: 'function_call', call_id: `call_${i}`, name: 'shell', arguments: JSON.stringify({ command: `node C:/project/check-${i}.js` }) },
    { type: 'function_call_output', call_id: `call_${i}`, output: 'The build check passed.\n'.repeat(180) },
  );
  return input;
}
const options = { keepTail: 4, keepRecentPairs: 2, minCollapsePrefix: 1, minCollapseTokens: 0,
  collapseChunk: 1, freezeChunk: 1, sectionTokens: 300, maxImages: 120, responsesMode: 'mixed', checkpointChunk: 50 };

test('130-item checkpoint keeps old pages identical until the next 130-item epoch', async () => {
  const opts = { ...options, checkpointChunk: 130, keepTail: 30 };
  const a = await H.planResponsesPairCollapse(responses(42), () => true, opts);
  const b = await H.planResponsesPairCollapse(responses(60), () => true, opts);
  const c = await H.planResponsesPairCollapse(responses(76), () => true, opts);
  assert.ok(a.selectedIndices.length > 0);
  assert.ok(Math.max(...a.selectedIndices) < 130);
  assert.deepEqual(b.selectedIndices, a.selectedIndices);
  assert.deepEqual(b.imageSources, a.imageSources);
  assert.ok(c.selectedIndices.length > b.selectedIndices.length);
});

test('Responses checkpoint holds selected indices and full source until the next 50-item epoch', async () => {
  const a = await H.planResponsesPairCollapse(responses(18), () => true, options);
  const b = await H.planResponsesPairCollapse(responses(20), () => true,
    { ...options, keepTail: 12, keepRecentPairs: 6 });
  assert.ok(a.selectedIndices.length > 0);
  assert.ok(Math.max(...a.selectedIndices) < 50);
  assert.deepEqual(b.selectedIndices, a.selectedIndices);
  assert.deepEqual(b.imageSources, a.imageSources);
  const c = await H.planResponsesPairCollapse(responses(31), () => true, options);
  assert.ok(c.selectedIndices.length > b.selectedIndices.length, 'a later epoch makes progress');
  const ids = new Set(c.selectedIndices);
  const input = responses(31);
  for (let i = 0; i < input.length; i++)
    if (ids.has(i) && input[i].type === 'function_call_output')
      assert.ok(ids.has(i - 1), 'never select an output without its call');
});

test('Chat checkpoint is stable across shell steps, including calm/tool tail floor changes', async () => {
  const messages = [{ role: 'user', content: 'inspect and test the project' }];
  for (let i = 0; i < 45; i++) messages.push(
    { role: 'assistant', content: `Inspect C:/project/${i}.js`, tool_calls: [{ id: `c${i}`, function: { name: 'shell', arguments: '{"command":"npm test"}' } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: 'Build passed.\n'.repeat(50) },
  );
  const plan = (n, keepTail) => H.planGptCollapse(H.chatMessagesToTurns(messages.slice(0, n), { dropTools: true }),
    0, () => true, { ...options, keepTail });
  const a = await plan(71, 4);
  const b = await plan(79, 12);
  assert.ok(a.endExclusive > 1 && a.endExclusive <= 50);
  assert.equal(b.endExclusive, a.endExclusive);
  assert.deepEqual(b.imageSources, a.imageSources);
});

const env = { PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_READ_NOTE: 0 };
test('managed shell pipeline appends to the complete outgoing prefix between checkpoints', () => withEnv({
  ...env,
  // Exercise the shipped reader geometry, not the library's legacy 14px fallback.
  PXPIPE_GPT_PROFILES: JSON.stringify(JSON.parse(fs.readFileSync(new URL('./config.default.json', import.meta.url))).gptProfiles),
}, async () => {
  const tc = createToolCollapse();
  const run = async n => {
    const body = { model: 'gpt-6.1-sol', input: responses(n) };
    // Stubs alone can correctly be cheaper as native text. Include imageable
    // assistant prose so this test exercises the frozen-image pipeline too.
    for (const m of body.input) if (m.role === 'assistant')
      m.content[0].text += ' Inspect the implementation and compare the documented behavior with the completed build checks.'.repeat(40);
    tc.apply(body, { sessionKey: 'pipeline-fixture' });
    return dec((await O.transformOpenAIResponses(enc(body),
      { gptHistory: { checkpointChunk: 50, sectionTokens: 300, maxImages: 100 } })).body);
  };
  const a = await run(18);
  assert.ok(a.input.some(m => m.content?.some?.(p => p.type === 'input_image')));
  for (const n of [19, 20, 23, 26, 27]) {
    const b = await run(n);
    assert.deepEqual(b.input.slice(0, a.input.length), a.input,
      `step ${n}: old envelopes, exact-value text, reasoning and tool outputs must all remain identical`);
  }
}));
for (const mode of ['chat', 'responses']) {
  test(`${mode}: appending tools keeps complete old rendered messages, including exact-value text`, () => withEnv(env, async () => {
    const build = n => {
      const input = responses(n);
      if (mode === 'responses') return { model: 'gpt-6.1-sol', input };
      const messages = [{ role: 'user', content: 'inspect the project' }];
      for (let i = 0; i < n; i++) messages.push(
        { role: 'assistant', content: `Inspect C:/project/check-${i}.js`, tool_calls: [{ id: `k${i}`, function: { name: 'shell', arguments: JSON.stringify({ command: `node C:/project/check-${i}.js` }) } }] },
        { role: 'tool', tool_call_id: `k${i}`, content: 'Build passed.\n'.repeat(180) },
      );
      return { model: 'gpt-6.1-sol', messages };
    };
    const run = mode === 'chat' ? O.transformOpenAIChatCompletions : O.transformOpenAIResponses;
    const opts = { gptHistory: { sectionTokens: 300, maxImages: 100 } };
    const aBody = build(30), original = JSON.stringify(aBody);
    const a = dec((await run(enc(aBody), opts)).body);
    const b = dec((await run(enc(build(34)), opts)).body);
    const groups = x => x[mode === 'chat' ? 'messages' : 'input'].filter(m =>
      m.content?.some?.(p => p.text?.startsWith('[Earlier turns in image(s):')));
    const ag = groups(a), bg = groups(b);
    assert.ok(ag.length > 1, 'frozen sections need separate stable message boundaries');
    assert.deepEqual(bg.slice(0, ag.length), ag, 'compare text, envelopes and image bytes, not PNGs alone');
    assert.equal(JSON.stringify(aBody), original);
  }));
}
