// node --test test-dedupe-blocks.mjs
// Rules under test (dedupe-blocks.mjs):
// - full body: a configured block repeated verbatim within the body becomes one marker line; the first copy stays.
// - delta body: a block already seen in the same conversation (session key) is replaced; other conversation or no key: untouched.
// - text outside the tags stays; <system-reminder> is never touched; assistant messages are not touched.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlockDedupe, dedupeMarker, parseDedupeTags } from './dedupe-blocks.mjs';

const BI = '<browser_instruction>\nUse the browser tools. Never type passwords.\n' + 'x'.repeat(3000) + '\n</browser_instruction>';
const MARK = '[browser_instruction lặp lại nguyên văn bản ở lượt trước — đã lược]';
const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const asst = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const clone = (v) => structuredClone(v);
const textsOf = (body) => body.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((b) => b.text).join('|')));

test('marker text is the fixed line from the spec', () => {
  assert.equal(dedupeMarker('browser_instruction'), MARK);
});

test('parseDedupeTags: default, off, list, never system-reminder', () => {
  const rows = [
    [undefined, ['browser_instruction']],
    ['', []],
    ['  ', []],
    ['0', []],
    ['browser_instruction', ['browser_instruction']],
    [' a , b,a ,, ', ['a', 'b']],
    ['system-reminder,foo', ['foo']],
    ['bad tag,<x>,ok_1', ['ok_1']],
  ];
  for (const [raw, want] of rows) assert.deepEqual(parseDedupeTags(raw), want, JSON.stringify(raw));
});

test('full body: later copies become the marker, first copy and typed text stay byte for byte', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'] });
  const body = {
    messages: [user(`${BI}\nopen example.com`), asst(`ok ${BI}`), user(`${BI}\nnow click login`), { role: 'user', content: `${BI} plain string` }],
  };
  const n = d.apply(body, { sessionKey: 's\u0000', bodyKind: 'full' });
  assert.equal(n, 2);
  assert.deepEqual(textsOf(body), [`${BI}\nopen example.com`, `ok ${BI}`, `${MARK}\nnow click login`, `${MARK} plain string`]);
});

test('full body: the next request of the session rewrites the shared prefix identically', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'] });
  const history = [user(`${BI}\nq1`), asst('a1'), user(`${BI}\nq2`)];
  const r1 = { messages: clone(history) };
  const r2 = { messages: [...clone(history), asst('a2'), user(`${BI}\nq3`)] };
  d.apply(r1, { sessionKey: 's\u0000', bodyKind: 'full' });
  d.apply(r2, { sessionKey: 's\u0000', bodyKind: 'full' });
  assert.equal(JSON.stringify(r2.messages.slice(0, 3)), JSON.stringify(r1.messages));
  assert.deepEqual(textsOf(r2).slice(3), ['a2', `${MARK}\nq3`]);
  assert.equal(r1.messages[0].content[0].text, `${BI}\nq1`);
});

test('delta body: replaced only for a block seen earlier in the same conversation', () => {
  const rows = [
    { name: 'same session, second delta', first: 's1', key: 's1', kind: 'delta', want: `${MARK}\nq2` },
    { name: 'other session', first: 's1', key: 's2', kind: 'delta', want: `${BI}\nq2` },
    { name: 'no session id', first: null, key: null, kind: 'delta', want: `${BI}\nq2` },
    { name: 'same session, full body: in-body rule only', first: 's1', key: 's1', kind: 'full', want: `${BI}\nq2` },
  ];
  for (const row of rows) {
    const d = createBlockDedupe({ tags: ['browser_instruction'] });
    const r1 = { messages: [user(`${BI}\nq1`)] };
    assert.equal(d.apply(r1, { sessionKey: row.first, bodyKind: 'delta' }), 0, row.name);
    assert.equal(r1.messages[0].content[0].text, `${BI}\nq1`, row.name);
    const r2 = { messages: [user(`${BI}\nq2`)] };
    d.apply(r2, { sessionKey: row.key, bodyKind: row.kind });
    assert.equal(r2.messages[0].content[0].text, row.want, row.name);
  }
});

test('delta body: a resent delta (retry of the same message) keeps its block', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'] });
  const msg = user(`${BI}\nq1`);
  d.apply({ messages: [clone(msg)] }, { sessionKey: 's', bodyKind: 'delta' });
  const retry = { messages: [clone(msg)] };
  assert.equal(d.apply(retry, { sessionKey: 's', bodyKind: 'delta' }), 0);
  assert.equal(retry.messages[0].content[0].text, `${BI}\nq1`);
});

test('delta body: a block first seen in a full body of the conversation is replaced in a later delta', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'] });
  d.apply({ messages: [user(`${BI}\nq1`)] }, { sessionKey: 's', bodyKind: 'full' });
  const r = { messages: [user(`${BI}\nq2`)] };
  d.apply(r, { sessionKey: 's', bodyKind: 'delta' });
  assert.equal(r.messages[0].content[0].text, `${MARK}\nq2`);
});

test('different block content is not a repeat; system-reminder and unconfigured tags stay', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'] });
  const other = BI.replace('Never', 'Always');
  const sr = '<system-reminder>CLAUDE.md rules</system-reminder>';
  const body = { messages: [user(`${BI}${sr}<foo>z</foo>`), user(`${other}${sr}<foo>z</foo>`)] };
  assert.equal(d.apply(body, { sessionKey: 's', bodyKind: 'full' }), 0);
  assert.deepEqual(textsOf(body), [`${BI}${sr}<foo>z</foo>`, `${other}${sr}<foo>z</foo>`]);
});

test('no tags configured: nothing changes', () => {
  const d = createBlockDedupe({ tags: [] });
  const body = { messages: [user(BI), user(BI)] };
  assert.equal(d.apply(body, { sessionKey: 's', bodyKind: 'full' }), 0);
  assert.deepEqual(textsOf(body), [BI, BI]);
});

test('session memory is an LRU bounded by maxSessions', () => {
  const d = createBlockDedupe({ tags: ['browser_instruction'], maxSessions: 2 });
  for (const s of ['a', 'b', 'c']) d.apply({ messages: [user(`${BI}\n${s}`)] }, { sessionKey: s, bodyKind: 'delta' });
  assert.equal(d.sessionCount(), 2);
  const evicted = { messages: [user(`${BI}\nlater`)] };
  d.apply(evicted, { sessionKey: 'a', bodyKind: 'delta' });
  assert.equal(evicted.messages[0].content[0].text, `${BI}\nlater`, 'a was evicted, so its block counts as new');
  const kept = { messages: [user(`${BI}\nlater`)] };
  d.apply(kept, { sessionKey: 'c', bodyKind: 'delta' });
  assert.equal(kept.messages[0].content[0].text, `${MARK}\nlater`);
});
