// Tool-chain cut: closed call/result pairs may be cut, open tool_use never, tail >= 12 in a chain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { findClosedPrefixBoundary, collapseHistory } from './vendor/pxpipe-proxy/dist/core/history.js';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

const use = (id) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/a' } }] });
const res = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(300) }] });

test('chain of adjacent pairs: strict refuses to cut inside, relaxed cuts after a matched pair', () => {
  const chain = [];
  for (let i = 0; i < 10; i++) chain.push(use('t' + i), res('t' + i));
  assert.equal(findClosedPrefixBoundary(chain, 9, false), -1);
  assert.equal(findClosedPrefixBoundary(chain, 9, true), 7);
});

test('an open tool_use is never crossed', () => {
  const open = [use('a'), res('a'), use('b'), use('c'), res('b')];
  assert.equal(findClosedPrefixBoundary(open, 5, true), 1);
});

test('parallel batch (two calls, two results) closes only after both results', () => {
  const par = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'p', name: 'R', input: {} }, { type: 'tool_use', id: 'q', name: 'R', input: {} }] },
    res('p'),
    res('q'),
  ];
  assert.equal(findClosedPrefixBoundary(par, 2, true), -1);
  assert.equal(findClosedPrefixBoundary(par, 3, true), 2);
});

const longChain = () => {
  const long = [{ role: 'user', content: 'start the job' }];
  for (let i = 0; i < 80; i++) long.push(use('L' + i), res('L' + i));
  return long;
};
const opts = { collapseChunk: 50, minCollapsePrefix: 10, keepTail: 4 };

test('collapseHistory on a long chain: cuts, tail stays >= 12, ids pair up', () =>
  // Gates off so the collapse really happens; the old test skipped every check when nothing collapsed.
  withEnv({ ...GATE_ENV_OFF, PXLITE_MIN_SHRINK_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0 }, async () => {
    const long = longChain();
    const { messages, info } = await collapseHistory(long, () => true, opts);
    assert.ok(info.collapsedTurns > 0, 'chain must collapse: ' + info.reason);
    assert.ok(long.length - info.collapsedTurns >= 12, `tail >= 12 (len=${long.length}, collapsed=${info.collapsedTurns})`);
    const uses = new Set();
    const results = new Set();
    for (const m of messages) {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'tool_use') uses.add(b.id);
        if (b.type === 'tool_result') results.add(b.tool_use_id);
      }
    }
    for (const id of results) assert.ok(uses.has(id), 'orphan tool_result ' + id);
    for (const id of uses) assert.ok(results.has(id), 'open tool_use ' + id);
  }));

test('PXLITE_TOOL_ROUND_CUT=0 keeps the old behaviour: chain is not cut', () =>
  withEnv({ ...GATE_ENV_OFF, PXLITE_MIN_SHRINK_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_TOOL_ROUND_CUT: 0 }, async () => {
    const off = await collapseHistory(longChain(), () => true, opts);
    assert.equal(off.info.collapsedTurns, 0);
    assert.equal(off.info.reason, 'prefix_too_short');
  }));
