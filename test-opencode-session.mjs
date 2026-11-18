import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenCodeSessionRecall, selectOpenCodeSession, openCodeTurns } from './recall-opencode-session.mjs';

const sessions = [
  { id: 'ses_current', title: 'current', location: { directory: 'D:\\NASA' }, time: { updated: 40 } },
  { id: 'ses_older', title: 'Old plan', location: { directory: 'D:/NASA' }, time: { updated: 30 } },
  { id: 'ses_other', title: 'Secret plan', location: { directory: 'D:/OTHER' }, time: { updated: 50 } },
];

test('session selection stays in the current directory and rejects ambiguous ids', () => {
  assert.equal(selectOpenCodeSession(sessions, 'ses_current', '').id, 'ses_older');
  assert.equal(selectOpenCodeSession(sessions, 'ses_current', 'old plan').id, 'ses_older');
  assert.equal(selectOpenCodeSession(sessions, 'ses_current', '@old plan').id, 'ses_older');
  assert.equal(selectOpenCodeSession(sessions, 'ses_current', 'ses_other'), null);
  assert.equal(selectOpenCodeSession(sessions, 'missing', ''), null);
});

test('transcript excludes tools, reasoning and synthetic instructions', () => {
  assert.deepEqual(openCodeTurns([
    { type: 'user', text: 'ask' },
    { type: 'synthetic', text: 'secret' },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'tool', text: 'payload' }, { type: 'text', text: 'answer' }] },
  ]), ['<user t="0">ask</user>', '<assistant t="1">answer</assistant>']);
});

test('last completed compaction summary replaces earlier era', () => {
  assert.deepEqual(openCodeTurns([
    { type: 'user', text: 'obsolete' },
    { type: 'compaction', summary: 'summary' },
    { type: 'user', text: 'new request' },
  ]), ['<earlier-summary>\nsummary\n</earlier-summary>', '<user t="1">new request</user>']);
});

test('responses recall pins transcript and never attaches for unverified id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-oc-'));
  let calls = 0;
  const r = createOpenCodeSessionRecall({
    pinDir: dir,
    list: async () => sessions,
    messages: async () => { calls++; return [{ type: 'user', text: 'old ask' }, { type: 'assistant', content: [{ type: 'text', text: 'old answer' }] }]; },
    render: async () => [{ png: Buffer.from('image') }],
  });
  const body = { model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recall old' }] }] };
  const a = await r.apply(body, new Headers());
  assert.equal(a.input[0].content[1].type, 'input_image');
  assert.deepEqual(await r.apply(body, new Headers()), a);
  assert.equal(calls, 1);
  assert.equal(await r.apply({ ...body, prompt_cache_key: 'not-an-id' }, new Headers()), null);
  assert.equal(await r.apply({ ...body, input: [{ role: 'user', content: [{ type: 'input_text', text: 'please recall old' }] }] }, new Headers()), null);
  const miss = await r.apply({ ...body, input: [{ role: 'user', content: [{ type: 'input_text', text: 'recall missing' }] }] }, new Headers());
  assert.match(miss.input[0].content[0].text, /No matching earlier OpenCode session/);
  assert.equal(miss.input[0].content.length, 1);
  const reopened = createOpenCodeSessionRecall({ pinDir: dir, list: async () => { throw Error('must use pin'); }, messages: async () => { throw Error('must use pin'); }, render: async () => [{ png: Buffer.from('image') }] });
  assert.deepEqual(await reopened.apply(body, new Headers()), a);
});

test('Chat Completions history transform preserves the recalled image', async () => {
  const { transformOpenAIChatCompletions } = await import('./vendor/pxpipe-proxy/dist/core/openai.js');
  const recall = { role: 'user', content: [
    { type: 'text', text: '[pxlite recall: fixture]' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
  ] };
  const messages = [recall, ...Array.from({ length: 80 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `turn ${i} ${'some conversational text '.repeat(80)}`,
  }))];
  const body = new TextEncoder().encode(JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages }));
  const out = await transformOpenAIChatCompletions(body, { compress: true, collapseHistory: true });
  const parsed = JSON.parse(new TextDecoder().decode(out.body));
  assert.ok(parsed.messages.some((m) => m.content?.some?.((p) => p.image_url?.url === 'data:image/png;base64,aW1hZ2U=')));
});

test('OpenAI history transform preserves the recalled image on a long request', async () => {
  const { transformOpenAIResponses } = await import('./vendor/pxpipe-proxy/dist/core/openai.js');
  const recall = { type: 'message', role: 'user', content: [
    { type: 'input_text', text: '[OpenCode session recall: fixture]' },
    { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
  ] };
  const input = [recall, ...Array.from({ length: 80 }, (_, i) => ({
    type: 'message', role: i % 2 ? 'assistant' : 'user',
    content: [{ type: i % 2 ? 'output_text' : 'input_text', text: `turn ${i} ${'some conversational text '.repeat(80)}` }],
  }))];
  const body = new TextEncoder().encode(JSON.stringify({ model: 'gpt-6.1-terra', input }));
  const out = await transformOpenAIResponses(body, { compress: true, collapseHistory: true });
  const parsed = JSON.parse(new TextDecoder().decode(out.body));
  assert.ok(parsed.input.some((item) => item.content?.some?.((p) => p.image_url === 'data:image/png;base64,aW1hZ2U=')));
});
