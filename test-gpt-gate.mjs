// GPT (Responses) path obeys the same collapse gate as the Claude path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

const items = (n, size) => {
  const a = [{ role: 'user', content: [{ type: 'input_text', text: 'go' }] }];
  for (let i = 0; i < n; i++) {
    a.push(
      { type: 'function_call', call_id: 'c' + i, name: 'shell', arguments: '{"c":"ls"}' },
      { type: 'function_call_output', call_id: 'c' + i, output: ('line ' + i + ' abc def ghi\n').repeat(Math.ceil(size / 20)) },
    );
  }
  return a;
};
const run = async (n, size) => {
  const body = new TextEncoder().encode(JSON.stringify({ model: 'gpt-6.2-sol', instructions: 'be brief', input: items(n, size) }));
  return (await transformOpenAIResponses(body, {})).info;
};
const pairs = (i) => i.collapsedFunctionPairs ?? i.responsesComposition?.collapsedFunctionPairs ?? 0;

test('Responses: small history does not collapse', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const small = await run(14, 3000);
    assert.equal(pairs(small), 0, 'small history must not collapse');
    assert.ok(!(small.collapsedTurns > 0));
  }));

test('Responses: large history collapses', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const big = await run(80, 4000);
    assert.ok(pairs(big) > 0 || big.collapsedTurns > 0, `large history should still collapse (reason=${big.historyReason})`);
  }));
