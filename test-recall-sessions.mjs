import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeFolder, createRecallSessions, isCandidate, matchCandidates } from './recall-sessions.mjs';

const ctx = { client: 'opencode', sid: 'ses_current', dir: 'D:\\NASA' };
const candidates = [
  { source: 'claude', id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Old plan', first: 'opening words', when: 10 },
  { source: 'opencode', id: 'ses_older', title: 'Vault note', first: '', when: 30 },
  { source: 'opencode', id: 'ses_new', title: 'Another vault', first: '', when: 20 },
  { source: 'opencode', id: 'ses_child', parentID: 'ses_current', title: 'Vault child', when: 40 },
];

test('directory encoding and candidate matching', () => {
  assert.equal(claudeFolder('D:\\QUANTUM MECHANICS'), 'D--QUANTUM-MECHANICS');
  assert.deepEqual(matchCandidates(candidates, '').map((c) => c.id), candidates.map((c) => c.id));
  assert.deepEqual(matchCandidates(candidates, 'vault').map((c) => c.id), ['ses_older', 'ses_new', 'ses_child']);
  assert.deepEqual(matchCandidates(candidates, 'old plan').map((c) => c.id), [candidates[0].id]);
  assert.deepEqual(matchCandidates(candidates, 'ses_old').map((c) => c.id), ['ses_older']);
  assert.deepEqual(matchCandidates(candidates, 'ses_').map((c) => c.id), []);
  assert.deepEqual(matchCandidates(candidates, 'aaaaaaaa').map((c) => c.id), [candidates[0].id]);
  assert.deepEqual(matchCandidates(candidates, '@vault note').map((c) => c.id), ['ses_older']);
  assert.deepEqual(matchCandidates(candidates, 'nothing here'), []);
  assert.equal(isCandidate({ id: 'ses_child', parentID: 'ses_current' }, ctx), false);
  assert.equal(isCandidate({ id: 'ses_child' }, ctx), true);
});

function harness(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-any-'));
  const calls = [];
  const r = createRecallSessions({
    pinDir: dir,
    context: async () => ctx,
    list: async () => candidates.filter((c) => !c.parentID).filter((c) => c.id !== ctx.sid),
    turns: async (c) => {
      calls.push(c.id);
      return [`<user t="0">ask ${c.id}</user>`, '<assistant t="1">answer</assistant>'];
    },
    render: async () => [{ png: Buffer.from('page') }],
    ...overrides,
  });
  return { r, dir, calls };
}

test('picks a source, pins its text and survives a newer session appearing', async () => {
  let pool = candidates.filter((c) => !c.parentID);
  const { r, calls } = harness({ list: async () => pool });
  const body = { model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recall vault' }] }] };
  const first = await r.apply(body, new Headers());
  assert.equal(first.input[0].content[1].type, 'input_image');
  assert.match(first.input[0].content[0].text, /"Vault note"/);
  assert.match(first.input[0].content[0].text, /OpenCode/);
  const newest = { ...candidates[1], id: 'ses_newest', title: 'Newest vault', when: 99 };
  pool = [newest, ...pool];
  const second = await r.apply(body, new Headers());
  assert.deepEqual(second, first); // pinned bytes, not the new session
  assert.deepEqual(calls, ['ses_older']);
  assert.equal(r.stats.opencode.injected, 2);
  assert.equal(r.stats.opencode.pinned, 1);
});

test('cross-source: the same directory serves Claude Code and OpenCode', async () => {
  const { r, calls } = harness({ context: async () => ({ client: 'claude', sid: 'aaaaaaaa-9999-0000-1111-222222222222', dir: 'D:\\NASA' }) });
  const body = { model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'recall old plan' }] }] };
  const out = await r.apply(body, new Headers());
  const content = out.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /Claude Code/);
  assert.equal(content[1].type, 'image');
  assert.deepEqual(calls, [candidates[0].id]);
  assert.equal(r.stats.claude.injected, 1);
});

test('messages mount keeps the command last and a marker prevents a second copy', async () => {
  const { r } = harness();
  const body = { model: 'gpt-6.1-terra', messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>\nrecall vault' }] }] };
  const out = await r.apply(body, new Headers());
  const content = out.messages[0].content;
  assert.equal(content.at(-1).text, '<system-reminder>ctx</system-reminder>\nrecall vault');
  assert.equal(await r.apply(out, new Headers()), null);
});

test('chat mount injects image_url parts, keeps the command last and drops tools', async () => {
  const { r } = harness();
  const body = {
    model: 'deepseek-v4.1-flash-free',
    tools: [{ type: 'function', function: { name: 'read', parameters: {} } }],
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'recall vault' }] },
    ],
  };
  const out = await r.apply(body, new Headers(), 'chat');
  const content = out.messages[1].content;
  assert.equal(content[0].type, 'text');
  assert.match(content[0].text, /"Vault note"/);
  assert.equal(content[1].type, 'image_url');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(content.at(-1).text, 'recall vault');
  assert.equal(out.tools, undefined);
  assert.equal(await r.apply(out, new Headers(), 'chat'), null);
});

test('messages mount also drops tools for the recall turn only', async () => {
  const { r } = harness();
  const body = {
    model: 'claude-sonnet-5-5',
    tools: [{ name: 'Read', input_schema: {} }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'recall vault' }] }],
  };
  const out = await r.apply(body, new Headers());
  assert.equal(out.tool_choice, undefined);
  assert.equal(out.tools, undefined);
  assert.equal(await r.apply({ ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, new Headers()), null);
});

test('responses mount rejects non-commands and reports a miss with recent sessions', async () => {
  const { r } = harness();
  const body = { model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'please recall vault' }] }] };
  assert.equal(await r.apply(body, new Headers()), null);
  const miss = await r.apply({ ...body, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recall nothing' }] }] }, new Headers());
  assert.match(miss.input[0].content[0].text, /no matching earlier session/);
  assert.match(miss.input[0].content[0].text, /Recent sessions/);
  assert.equal(miss.input[0].content.length, 1);
  assert.equal(r.stats.opencode.noMatch, 1);
});

test('an unreadable candidate falls through to the next match', async () => {
  const { r, calls } = harness({
    turns: async (c) => {
      calls.push(c.id);
      if (c.id === 'ses_older') throw new Error('gone');
      return [`<user t="0">ask</user>`];
    },
  });
  const body = { model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recall vault' }] }] };
  const out = await r.apply(body, new Headers());
  assert.match(out.input[0].content[0].text, /"Another vault"/);
  assert.deepEqual(calls, ['ses_older', 'ses_new']);
});
