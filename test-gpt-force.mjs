// GPT path: >=180k estimated tokens forces collapse even with few messages (Chat Completions + Responses).
import assert from 'node:assert/strict';
import test from 'node:test';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const msgs = (n, size) => {
  const a = [{ role: 'system', content: 'x' }];
  for (let i = 0; i < n; i++) a.push({ role: i % 2 ? 'assistant' : 'user', content: ('line ' + i + ' abc def ghi\n').repeat(Math.ceil(size / 20)) });
  return a;
};
const chat = async (n, size) => (await transformOpenAIChatCompletions(enc({ model: 'gpt-6.2-sol', messages: msgs(n, size) }), {})).info;
const collapsed = (i) => (i.collapsedTurns ?? 0) > 0 || i.historyReason === 'collapsed';

test('Chat Completions: 30 messages x 100KB (~3MB chars) is forced to collapse', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const a = await chat(30, 100000);
    assert.ok(collapsed(a), `forced collapse above 180k with <50 messages (reason=${a.historyReason})`);
  }));

test('Chat Completions: small history stays', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const small = await chat(30, 2000);
    assert.ok(!collapsed(small), 'small stays');
  }));

test('Chat Completions: PXLITE_FORCE_COLLAPSE_TOKENS=0 falls back to the 50-message gate', () =>
  withEnv({ ...GATE_ENV_OFF, PXLITE_FORCE_COLLAPSE_TOKENS: 0 }, async () => {
    const b = await chat(30, 100000);
    assert.ok(!collapsed(b), `disabled -> normal 50 message gate (reason=${b.historyReason})`);
  }));

test('Responses: forced collapse above 180k with few items', () =>
  withEnv(GATE_ENV_OFF, async () => {
    const input = [
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      ...Array.from({ length: 20 }, (_, i) => [
        { type: 'function_call', call_id: 'c' + i, name: 's', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c' + i, output: ('l' + i + ' abc\n').repeat(6000) },
      ]).flat(),
    ];
    const r = (await transformOpenAIResponses(enc({ model: 'gpt-6.2-sol', instructions: 'x', input }), {})).info;
    assert.ok((r.responsesComposition?.collapsedFunctionPairs ?? 0) > 0, 'responses forced');
  }));
