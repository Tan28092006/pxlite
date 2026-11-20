// Tool-result collapse: no API, pure logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolCollapse } from './collapse-tools.mjs';

const big = (c, n = 3000) => `${c} head\n` + 'line of output\n'.repeat(n / 15) + 'done ok';
function convo(n, tools = ['Bash']) {
  const messages = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < n; i++) {
    const name = tools[i % tools.length];
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: name === 'Write' ? { content: 'x'.repeat(5000) } : { command: 'ls' } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: big(`out${i}`) }] });
  }
  return { messages };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const collapsed = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((x) => x.type === 'tool_result' && String(x.content).includes('pxlite: older output collapsed')).length;

test('first request: cold cache, boundary jumps to n - keepTail', () => {
  const tc = createToolCollapse({ keepTail: 20 });
  const b = convo(60);
  const n = tc.apply(b, { sessionKey: 's' });
  assert.ok(n > 0);
  // newest 20 messages untouched
  assert.ok(!JSON.stringify(b.messages.slice(-20)).includes('pxlite: older'));
  // head and last line kept
  const first = b.messages[2].content[0].content;
  assert.ok(first.startsWith('out0 head') && first.includes('last line: done ok'));
});

test('boundary stays put between chunks: prefix is byte-identical (cache hits)', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 100, now: () => t });
  const full = convo(200);
  const a = clone({ messages: full.messages.slice(0, 80) });
  tc.apply(a, { sessionKey: 's' });
  t += 30_000;
  const b = clone({ messages: full.messages.slice(0, 120) });
  tc.apply(b, { sessionKey: 's' });
  const pre = (x) => JSON.stringify(x.messages.slice(0, 60));
  assert.equal(pre(a), pre(b));
});

test('boundary advances by a whole chunk when the gain pays off', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 50, minGainChars: 1000, now: () => t });
  const full = convo(200);
  tc.apply(clone({ messages: full.messages.slice(0, 80) }), { sessionKey: 's' });
  t += 10_000;
  const b = clone({ messages: full.messages.slice(0, 200) });
  tc.apply(b, { sessionKey: 's' });
  assert.ok(collapsed(b) > 60 / 2);
});

test('does not advance when the gain is too small', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 50, minGainChars: 10_000_000, now: () => t });
  const full = convo(200);
  const a = clone({ messages: full.messages.slice(0, 80) });
  tc.apply(a, { sessionKey: 's' });
  t += 10_000;
  const b = clone({ messages: full.messages.slice(0, 300) });
  tc.apply(b, { sessionKey: 's' });
  assert.equal(collapsed(b), collapsed(a));
});

test('cache expired (gap > TTL): boundary jumps for free', () => {
  let t = 0;
  const tc = createToolCollapse({ keepTail: 20, chunk: 1000, minGainChars: 10_000_000, ttlMs: 3_600_000, now: () => t });
  const full = convo(200);
  const a = clone({ messages: full.messages.slice(0, 80) });
  tc.apply(a, { sessionKey: 's' });
  t += 3_600_001;
  const b = clone({ messages: full.messages.slice(0, 300) });
  tc.apply(b, { sessionKey: 's' });
  assert.ok(collapsed(b) > collapsed(a));
});

test('never touches Read/Grep/Glob/MCP, errors, images or the last keepTail', () => {
  const tc = createToolCollapse({ keepTail: 4 });
  const b = convo(40, ['Read', 'Grep', 'Glob', 'mcp__graph__query']);
  assert.equal(tc.apply(b, { sessionKey: 'k' }), 0);
  const e = convo(40);
  e.messages[2].content[0].content = big('Error: command failed with exit code 1');
  e.messages[4].content[0].is_error = true;
  e.messages[6].content[0].content = [{ type: 'image', source: {} }];
  const tc2 = createToolCollapse({ keepTail: 4 });
  tc2.apply(e, { sessionKey: 'k' });
  assert.ok(!String(e.messages[2].content[0].content).includes('pxlite: older'));
  assert.ok(!String(e.messages[4].content[0].content).includes('pxlite: older'));
  assert.ok(Array.isArray(e.messages[6].content[0].content));
});

test('Write keeps the start of the file content in tool_use input', () => {
  const tc = createToolCollapse({ keepTail: 4 });
  const b = convo(40, ['Write']);
  tc.apply(b, { sessionKey: 'w' });
  const c = b.messages[1].content[0].input.content;
  assert.ok(c.startsWith('x'.repeat(600)) && c.length < 900 && c.includes('dropped'));
});

test('history shrinking (compaction) resets state; no key = no-op; idempotent', () => {
  const tc = createToolCollapse({ keepTail: 10 });
  assert.equal(tc.apply(convo(30), {}), 0);
  const b = convo(60);
  tc.apply(b, { sessionKey: 'r' });
  const again = clone(b);
  assert.equal(tc.apply(again, { sessionKey: 'r' }), 0); // already collapsed blocks are skipped
  const small = convo(8);
  assert.doesNotThrow(() => tc.apply(small, { sessionKey: 'r' }));
});
