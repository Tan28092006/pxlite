import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeFolder, createRecallSessions, driveSpellings, isCandidate, listCandidates, matchCandidates } from './recall-sessions.mjs';

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

test('cross-source both ways: OpenCode recalls a Claude Code session, Claude Code recalls an OpenCode one', async () => {
  const oc = harness(); // ctx is OpenCode
  const toClaude = await oc.r.apply({ model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recall aaaaaaaa' }] }] }, new Headers());
  assert.match(toClaude.input[0].content[0].text, /Claude Code/);
  assert.deepEqual(oc.calls, ['aaaaaaaa-1111-2222-3333-444444444444']);
  const cc = harness({ context: async () => ({ client: 'claude', sid: 'bbbbbbbb-0000-0000-0000-000000000000', dir: 'D:\\NASA' }) });
  const toOpenCode = await cc.r.apply({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'recall ses_older' }] }] }, new Headers());
  assert.match(toOpenCode.messages[0].content[0].text, /OpenCode/);
  assert.deepEqual(cc.calls, ['ses_older']);
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
  assert.ok(out.tools?.length, 'tools stay so tool references in history resolve');
  assert.equal(out.tool_choice, 'none');
  assert.equal(await r.apply(out, new Headers(), 'chat'), null);
});

test('messages mount also blocks tool calls for the recall turn only', async () => {
  const { r } = harness();
  const body = {
    model: 'claude-sonnet-5-5',
    tools: [{ name: 'Read', input_schema: {} }],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'recall vault' }] }],
  };
  const out = await r.apply(body, new Headers());
  assert.deepEqual(out.tool_choice, { type: 'none' });
  assert.deepEqual(out.tools, body.tools, 'tools stay so tool references in history resolve');
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

// Clients put other text blocks in the same user message: Claude Code in VS Code sends
// <browser_instruction> (and IDE context) as its own block before the typed text, and
// OpenCode can add synthetic text parts. The command is one typed block, not the whole message.
const extra = '<browser_instruction># Claude in Chrome\nLoad tools first.</browser_instruction>';

test('messages: a command in its own block next to client-added blocks still triggers', async () => {
  const { r } = harness();
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: extra }, { type: 'text', text: 'recall vault' }] }] };
  const out = await r.apply(body, new Headers());
  assert.ok(out, 'recall must trigger');
  const content = out.messages[0].content;
  assert.equal(content[0].text, extra);
  assert.match(content[1].text, /"Vault note"/);
  assert.equal(content[2].type, 'image');
  assert.equal(content.at(-1).text, 'recall vault');
  assert.equal(await r.apply(out, new Headers()), null);
});

test('responses: a command part next to a synthetic part still triggers', async () => {
  const { r } = harness();
  const body = {
    model: 'gpt-6.1-terra',
    prompt_cache_key: 'ses_current',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Called the Read tool with the following input: {"filePath":"a.md"}' }, { type: 'input_text', text: 'recall vault' }] }],
  };
  const out = await r.apply(body, new Headers());
  assert.ok(out, 'recall must trigger');
  assert.match(out.input[0].content[0].text, /"Vault note"/);
  assert.equal(out.input[0].content[1].type, 'input_image');
});

test('chat: a command part next to another text part still triggers', async () => {
  const { r } = harness();
  const body = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: [{ type: 'text', text: extra }, { type: 'text', text: 'recall vault' }] }] };
  const out = await r.apply(body, new Headers(), 'chat');
  assert.ok(out, 'recall must trigger');
  const content = out.messages[0].content;
  assert.equal(content[0].text, extra);
  assert.equal(content[2].type, 'image_url');
  assert.equal(content.at(-1).text, 'recall vault');
});

test('a block that only mentions recall inside other text is not a command', async () => {
  const { r } = harness();
  const blocks = [{ type: 'text', text: extra }, { type: 'text', text: 'please recall vault' }];
  assert.equal(await r.apply({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: blocks }] }, new Headers()), null);
  assert.equal(await r.apply({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: blocks }] }, new Headers(), 'chat'), null);
  const parts = blocks.map((b) => ({ type: 'input_text', text: b.text }));
  assert.equal(await r.apply({ model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: parts }] }, new Headers()), null);
});

// "recall" typed partway through a conversation: the recalled turns join the first user
// message (pxpipe keeps that one whole when it images old history, and its session anchor
// is the first text block, which stays put), the note says when it was loaded, and tools
// are dropped only for the turn that answers the command.
const tools = [{ name: 'Read', input_schema: {} }];
const midway = (extraTurns = []) => [
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>a</system-reminder>' }, { type: 'text', text: 'first task' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  { role: 'user', content: [{ type: 'text', text: extra }, { type: 'text', text: 'recall vault' }] },
  ...extraTurns,
];

test('messages: recall partway through attaches to the first message and drops tools for that turn only', async () => {
  const { r } = harness();
  const out = await r.apply({ model: 'claude-opus-5-5', tools, messages: midway() }, new Headers());
  assert.ok(out, 'recall must trigger');
  const first = out.messages[0].content;
  assert.equal(first[1].text, 'first task');
  assert.match(first[2].text, /"Vault note"/);
  assert.match(first[2].text, /partway through/);
  assert.equal(first[3].type, 'image');
  assert.deepEqual(out.messages.slice(1), midway().slice(1));
  assert.deepEqual(out.tool_choice, { type: 'none' });
  assert.deepEqual(out.tools, tools);

  const later = midway([{ role: 'assistant', content: [{ type: 'text', text: 'Loaded Vault note.' }] }, { role: 'user', content: [{ type: 'text', text: 'now read a.md' }] }]);
  const next = await r.apply({ model: 'claude-opus-5-5', tools, messages: later }, new Headers());
  assert.deepEqual(next.tools, tools, 'later turns keep their tools');
  assert.equal(next.tool_choice, undefined, 'later turns may call tools again');
  assert.deepEqual(next.messages[0], out.messages[0], 'the first message stays byte-identical, so the cache prefix holds');
});

test('messages: a recall in the first message keeps tools on every later turn', async () => {
  const { r } = harness();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'recall vault' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Loaded.' }] },
    { role: 'user', content: [{ type: 'text', text: 'go on' }] },
  ];
  const out = await r.apply({ model: 'claude-opus-5-5', tools, messages }, new Headers());
  assert.equal(out.messages[0].content[1].type, 'image');
  assert.doesNotMatch(out.messages[0].content[0].text, /partway through/);
  assert.deepEqual(out.tools, tools);
});

test('chat: recall partway through attaches to the first user message', async () => {
  const { r } = harness();
  const body = { model: 'deepseek-v4.1-flash-free', tools: [{ type: 'function', function: { name: 'read' } }], messages: [{ role: 'system', content: 'sys' }, ...midway()] };
  const out = await r.apply(body, new Headers(), 'chat');
  const first = out.messages[1].content;
  assert.match(first[2].text, /partway through/);
  assert.equal(first[3].type, 'image_url');
  assert.equal(out.tool_choice, 'none');
  const later = { ...body, messages: [...body.messages, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] };
  assert.deepEqual((await r.apply(later, new Headers(), 'chat')).tools, body.tools);
});

test('responses: recall partway through inserts before the first user item and keeps tools after it', async () => {
  const { r } = harness();
  const toInput = (msgs) => msgs.map((m) => ({ type: 'message', role: m.role, content: m.content.map((b) => ({ type: m.role === 'user' ? 'input_text' : 'output_text', text: b.text })) }));
  const body = { model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', tools: [{ type: 'function', name: 'read' }], input: toInput(midway()) };
  const out = await r.apply(body, new Headers());
  assert.match(out.input[0].content[0].text, /partway through/);
  assert.equal(out.input[0].content[1].type, 'input_image');
  assert.equal(out.tool_choice, 'none');
  const later = { ...body, input: [...body.input, { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c1', output: 'x' }] };
  assert.deepEqual((await r.apply(later, new Headers())).tools, body.tools);
});

// Regression: Claude Code's ToolSearch leaves tool_reference blocks in history; the API
// rejects the request when `tools` no longer lists them ("Tool reference 'SendMessage' not
// found in available tools"), so the recall turn must keep every tool definition.
test('messages: history with tool_reference blocks keeps its tools on the recall turn', async () => {
  const { r } = harness();
  const tools = [{ name: 'ToolSearch', input_schema: {} }, { name: 'SendMessage', input_schema: {}, defer_loading: true }];
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'find SendMessage' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:SendMessage' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'SendMessage' }] }] },
    { role: 'assistant', content: [{ type: 'text', text: 'loaded' }] },
    { role: 'user', content: [{ type: 'text', text: 'recall vault' }] },
  ];
  const out = await r.apply({ model: 'claude-opus-5-5', tools, messages }, new Headers());
  assert.ok(out.messages[0].content.some((b) => b.type === 'image'));
  assert.deepEqual(out.tools, tools);
  assert.deepEqual(out.tool_choice, { type: 'none' });
});

// Regression: Claude Code in VS Code reports cwd "d:\\THG" while OpenCode stores "D:\\THG", and
// OpenCode's session API matches the directory case-sensitively, so "recall ses_…" from
// Claude Code found no OpenCode session at all.
test('driveSpellings tries a Windows drive letter in both cases', () => {
  assert.deepEqual(driveSpellings('d:\\THG'), ['d:\\THG', 'D:\\THG']);
  assert.deepEqual(driveSpellings('D:\\THG'), ['D:\\THG', 'd:\\THG']);
  assert.deepEqual(driveSpellings('/home/u/x'), ['/home/u/x']);
  assert.deepEqual(driveSpellings(''), []);
});

test('listCandidates finds OpenCode sessions stored under the other drive-letter case', async () => {
  const stored = { 'D:\\NOPE-PXLITE-TEST': [{ id: 'ses_abc', title: 'Upper', time: { updated: 5 } }] };
  const asked = [];
  const lister = async (dir) => {
    asked.push(dir);
    return stored[dir] ?? [];
  };
  const out = await listCandidates({ client: 'claude', sid: 'cur', dir: 'd:\\NOPE-PXLITE-TEST' }, lister);
  assert.deepEqual(asked, ['d:\\NOPE-PXLITE-TEST', 'D:\\NOPE-PXLITE-TEST']);
  assert.deepEqual(out.map((c) => c.id), ['ses_abc']);
  assert.deepEqual(matchCandidates(out, 'ses_abc').map((c) => c.id), ['ses_abc']);
});

// The note says when the source may be opened and how: search with rg, never read whole.
test('recall note names the transcript and how to search it; an OpenCode source asks the user', async () => {
  const withFile = candidates.map((c) => (c.source === 'claude' ? { ...c, file: 'C:\\t\\aaaa.jsonl' } : c));
  const { r } = harness({ list: async () => withFile.filter((c) => !c.parentID) });
  const ask = (text) => ({ model: 'gpt-6.1-terra', prompt_cache_key: 'ses_current', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] });
  const claudeNote = (await r.apply(ask('recall aaaaaaaa'), new Headers())).input[0].content[0].text;
  assert.match(claudeNote, /Answer from the images first/);
  assert.ok(claudeNote.includes('rg -uu -F -m 5 "<exact text>" "C:\\t\\aaaa.jsonl"'), claudeNote);
  assert.match(claudeNote, /never read it whole/);
  assert.match(claudeNote, /Each tool call is one line/);
  assert.doesNotMatch(claudeNote, /exact values \(names, numbers, passwords\) are in the images/);
  const { r: r2 } = harness();
  const ocNote = (await r2.apply(ask('recall vault note'), new Headers())).input[0].content[0].text;
  assert.match(ocNote, /OpenCode session with no file on disk: ask the user/);
  assert.doesNotMatch(ocNote, /rg -uu/);
});
