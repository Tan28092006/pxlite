import assert from 'node:assert/strict';
import test from 'node:test';
import { planResponsesSummaryCollapse } from './vendor/pxpipe-proxy/dist/core/openai-history.js';

const history = (n = 130) => Array.from({ length: n }, (_, i) =>
  ({ role: i % 2 ? 'assistant' : 'user', content: `Public step ${i}.` }));
const reasoning = () => ({ type: 'reasoning', id: 'reasoning', encrypted_content: 'PRIVATE_OPAQUE',
  summary: [{ type: 'summary_text', text: 'Check the implementation.' }] });
const call = (id, name = 'read', args = { path: `/repo/${id}.js` }) =>
  ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const output = (id, body = 'successful source contents') =>
  ({ type: 'function_call_output', call_id: id, output: body });
const fixture = middle => { const a = history(); a.splice(1, middle.length, ...middle); return a; };
const plan = (items, extra = {}) => planResponsesSummaryCollapse(items, () => true, {
  projectionVersion: 3, minCollapseTokens: 0, maxImages: 100, reflow: false, ...extra,
});
const selected = (p, ...indices) => indices.every(i => p.selectedIndices.includes(i));

test('known synchronous/direct-call and named-output metadata does not pin a complete pair', async () => {
  const a = fixture([reasoning(),
    { ...call('meta'), async: false, caller: { type: 'direct' }, namespace: 'functions' },
    { ...output('meta'), name: 'read', namespace: 'functions', caller: { type: 'direct' } }]);
  const before = structuredClone(a), p = await plan(a);
  assert.ok(selected(p, 1, 2, 3));
  assert.equal(p.pairState.collapsedPairs, 1);
  assert.match(p.text, /functions\.read/);
  assert.doesNotMatch(p.text, /successful source contents|PRIVATE_OPAQUE/);
  assert.deepEqual(a, before);
});

test('unknown caller, pending async and mismatched names remain native', async () => {
  for (const [c, o] of [
    [{ ...call('bad'), caller: { type: 'other', secret: 'opaque' } }, output('bad')],
    [{ ...call('bad'), async: true }, output('bad')],
    [call('bad'), { ...output('bad'), name: 'different_tool' }],
    [{ ...call('bad'), name: 42 }, { ...output('bad'), name: 'read' }],
  ]) {
    const p = await plan(fixture([reasoning(), c, o]));
    assert.ok(!selected(p, 1, 2, 3));
    assert.equal(p.pairState.collapsedPairs, 0);
    assert.equal(p.summaryState.nativeToolPairReasons.native_tool_shape, 1);
  }
});

test('interleaved completed call intervals are one atomic interval, not six malformed items', async () => {
  const a = fixture([reasoning(), call('A'), call('B'), output('A'), call('C'),
    output('B'), output('C')]);
  const p = await plan(a);
  assert.ok(selected(p, 1, 2, 3, 4, 5, 6, 7));
  assert.equal(p.pairState.completedPairs, 3);
  assert.equal(p.pairState.collapsedPairs, 3);
  assert.equal(p.pairState.malformedItems, 0);
  assert.match(p.text, /\/repo\/A\.js/);
  assert.match(p.text, /\/repo\/B\.js/);
  assert.match(p.text, /\/repo\/C\.js/);
});

test('known commentary between a call and its output is transcribed in original order', async () => {
  const a = fixture([reasoning(), call('A'), { type: 'message', role: 'assistant',
    phase: 'commentary', content: [{ type: 'output_text', text: 'PUBLIC_BETWEEN', annotations: [] }] },
    output('A', 'Do not carry successful read contents')]);
  const p = await plan(a);
  assert.ok(selected(p, 1, 2, 3, 4));
  assert.equal(p.pairState.collapsedPairs, 1);
  assert.ok(p.text.indexOf('/repo/A.js') < p.text.indexOf('PUBLIC_BETWEEN'));
  assert.match(p.text, /phase="commentary"/);
  assert.doesNotMatch(p.text, /Do not carry successful read contents/);
});

test('unknown interleaved native state protects the entire interval with a diagnostic', async () => {
  const p = await plan(fixture([reasoning(), call('A'),
    { type: 'unknown_native', opaque: 'do-not-interpret' }, call('B'),
    output('A'), output('B')]));
  assert.equal(p.pairState.completedPairs, 2);
  assert.equal(p.pairState.collapsedPairs, 0);
  assert.ok(!p.selectedIndices.includes(2) && !p.selectedIndices.includes(4));
  assert.equal(p.summaryState.nativeToolPairReasons.native_interleaved_state, 2);
});

test('an unresolved earlier call protects a later complete pair even across commentary', async () => {
  const p = await plan(fixture([{ ...call('pending'), status: 'in_progress' },
    { type: 'message', role: 'assistant', phase: 'commentary', content: 'Waiting.' },
    call('B'), output('B')]));
  assert.ok(!p.selectedIndices.includes(3) && !p.selectedIndices.includes(4));
  assert.equal(p.pairState.openCalls, 1);
  assert.equal(p.pairState.collapsedPairs, 0);
});

test('empty known assistant wrappers do not poison a completed reasoning/tool group', async () => {
  for (const content of [[], '', [{ type: 'output_text', text: ' \n', annotations: [] }]]) {
    const p = await plan(fixture([reasoning(), { type: 'message', role: 'assistant',
      status: 'completed', content }, call('empty'), output('empty')]));
    assert.ok(selected(p, 1, 2, 3, 4));
    assert.equal(p.pairState.collapsedPairs, 1);
  }
});

test('null ciphertext and empty reasoning content are known empty states, not wrapper barriers', async () => {
  for (const r of [{ ...reasoning(), encrypted_content: null },
    { ...reasoning(), content: [] }, { ...reasoning(), content: [], encrypted_content: null }]) {
    const p = await plan(fixture([r, call('empty-reasoning'), output('empty-reasoning')]));
    assert.ok(selected(p, 1, 2, 3));
    assert.equal(p.pairState.collapsedPairs, 1);
    assert.doesNotMatch(p.text, /PRIVATE_OPAQUE/);
  }
});

test('namespaced subagent reports preserve public results and continuation handles', async () => {
  const p = await plan(fixture([reasoning(), call('agent', 'functions.task',
    { description: 'Inspect the fix', prompt: 'Review it', agent: 'general' }),
    output('agent', JSON.stringify({ sessionID: 'ses_keep_agent', result: 'PUBLIC_AGENT_FINDING',
      content: [{ type: 'thinking', thinking: 'PRIVATE_CHILD' }] }))]));
  assert.equal(p.pairState.collapsedPairs, 1);
  assert.match(p.text, /functions\.task/);
  assert.match(p.text, /PUBLIC_AGENT_FINDING/);
  assert.match(p.text, /ses_keep_agent/);
  assert.doesNotMatch(p.text, /PRIVATE_CHILD/);
});

test('parallel wrapper expands every child breadcrumb, including middle files', async () => {
  const uses = Array.from({ length: 12 }, (_, i) => ({ recipient_name: 'functions.read',
    parameters: { path: `/repo/middle-${i}.js` } }));
  const p = await plan(fixture([reasoning(), call('wrapper', 'multi_tool_use.parallel',
    { tool_uses: uses }), output('wrapper', 'All reads completed.')]));
  assert.equal(p.pairState.collapsedPairs, 1);
  for (let i = 0; i < uses.length; i++) assert.match(p.text, new RegExp(`/repo/middle-${i}\\.js`));
  assert.doesNotMatch(p.text, /All reads completed/);
});

test('v1 and v2 remain replayable with their old conservative shape guards', async () => {
  const a = fixture([reasoning(), { ...call('meta'), async: false }, output('meta')]);
  for (const projectionVersion of [1, 2]) {
    const p = await plan(a, { projectionVersion });
    assert.equal(p.pairState.collapsedPairs, 0);
    assert.ok(!p.selectedIndices.includes(1));
  }
});

test('a cross-grid interleaved interval is carried whole into the next epoch', async () => {
  const a = history(180);
  a.splice(46, 9, reasoning(), call('A'), call('B'), output('A'), call('C'),
    output('B'), output('C'), { role: 'assistant', content: 'Done.' },
    { role: 'user', content: 'Continue.' });
  const first = await plan(a.slice(0, 80)), next = await plan(a.slice(0, 130));
  assert.ok(!first.selectedIndices.includes(47));
  assert.ok(selected(next, 46, 47, 48, 49, 50, 51, 52));
  assert.deepEqual(next.segments.slice(0, first.segments.length), first.segments);
});
