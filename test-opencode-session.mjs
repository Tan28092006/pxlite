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

test('transcript excludes reasoning, tool output and non-subagent synthetic messages', () => {
  assert.deepEqual(openCodeTurns([
    { type: 'user', text: 'ask' },
    { type: 'synthetic', text: 'secret' },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hidden' }, { type: 'tool', name: 'shell', state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'payload' }] } }, { type: 'text', text: 'answer' }] },
  ]), ['<user t="0">\nask\n</user>', '<assistant t="1">\n[shell] ls\nanswer\n</assistant>']);
});

// Shapes from a real session (ses_e12c9644…, 2026-11-18).
test('OpenCode turns keep one line per call, errors, subagent results and attachments', () => {
  const tool = (name, input, extra = {}) => ({ type: 'tool', name, state: { status: 'completed', input, content: [{ type: 'text', text: 'OUTPUT-BODY' }], ...extra } });
  const turns = openCodeTurns([
    { type: 'user', text: 'look', files: [{ mime: 'image/png', name: 'image.png', data: 'AAAA' }, { mime: 'application/pdf', name: 'spec.pdf', data: 'BBBB' }] },
    { type: 'assistant', content: [{ type: 'text', text: 'lead-in' }, tool('skill', { id: 'workflow' }), tool('read', { path: 'D:\\x\\SPEC.md' }, { status: 'error', error: { message: 'File not found: SPEC.md' } })] },
    { type: 'system', text: 'The Code Mode tool catalog has changed.' },
    { type: 'assistant', content: [tool('patch', { patchText: '*** Begin Patch\n*** Update File: D:\\x\\TASKS.md\n@@\n-a\n+b\n*** End Patch' }), tool('subagent', { agent: 'general', description: 'T1', prompt: 'do T1' })] },
    { type: 'synthetic', text: '<subagent sessionID="ses_c" state="cancelled" description="T1">\nSubagent cancelled\n</subagent>', description: 'T1', metadata: { source: 'subagent', agent: 'General', state: 'cancelled' } },
    { type: 'idle', outcome: 'succeeded' },
    { type: 'assistant', content: [{ type: 'text', text: 'final' }] },
  ]);
  const all = turns.join('\n');
  assert.equal(turns.length, 2, 'consecutive assistant messages form one turn');
  for (const kept of [/look\n\[image: image\.png\]\n\[file: spec\.pdf\]/, /lead-in/, /\[skill\] workflow/, /\[read\] D:\\x\\SPEC\.md/, /\[read error\] File not found: SPEC\.md/,
    /\[patch\] Update D:\\x\\TASKS\.md/, /\[Subagent general\] T1: do T1/, /\[Message from subagent General \(cancelled\): T1\]\nSubagent cancelled/, /final\n<\/assistant>$/]) assert.match(all, kept);
  for (const gone of [/OUTPUT-BODY/, /AAAA/, /tool catalog/, /\+b/, /<subagent /]) assert.doesNotMatch(all, gone);
});

test('last completed compaction summary replaces earlier era', () => {
  assert.deepEqual(openCodeTurns([
    { type: 'user', text: 'obsolete' },
    { type: 'compaction', summary: 'summary' },
    { type: 'user', text: 'new request' },
  ]), ['<earlier-summary>\nsummary\n</earlier-summary>', '<user t="0">\nnew request\n</user>']);
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
