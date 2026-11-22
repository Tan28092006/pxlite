// New summary checkpoints only. Local renderer; no remote API calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as H from './vendor/pxpipe-proxy/dist/core/openai-history.js';

const options = { minCollapseTokens: 0, maxImages: 100, reflow: false };
const msg = (i, role = 'assistant') => ({ role, content: `Public result at original turn ${i}.` });
const reasoning = (i, summary = `Public note ${i}`) => ({
  type: 'reasoning', id: `r${i}`, encrypted_content: `NEVER_RENDER_CIPHERTEXT_${i}`,
  summary: summary === undefined ? [] : [{ type: 'summary_text', text: summary }],
});
const call = (id, name = 'Read', args = { filePath: `/source/${id}.js` }) =>
  ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const output = (id, text = 'successful Read body must disappear') =>
  ({ type: 'function_call_output', call_id: id, output: text });
const history = (n = 130) => Array.from({ length: n }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user'));
const native = (n = 80) => Array.from({ length: n }, (_, i) =>
  i === 0 ? msg(i, 'user') : { role: 'system', content: `authoritative ${i}` });
const plan = (items, opts = {}, gate = () => true) =>
  H.planResponsesSummaryCollapse(items, gate, { ...options, ...opts });
const frozen = v => {
  if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v); }
  return v;
};
const has = (p, ...indices) => indices.every(i => p.selectedIndices.includes(i));
const lacks = (p, ...indices) => indices.every(i => !p.selectedIndices.includes(i));

test('v5 projects old successful tools directly into images without a second 30k/per-page veto', async () => {
  const items = history(80);
  items[1] = call('old-shell', 'shell', { command: 'npm test' });
  items[2] = output('old-shell', 'SUCCESS_BODY_TO_DROP '.repeat(80));
  const before = structuredClone(items);
  const v4 = await plan(items, { projectionVersion: 4, minCollapseTokens: 30000 }, () => false);
  assert.ok(lacks(v4, 1, 2));
  const p = await plan(items, { projectionVersion: 5, minCollapseTokens: 30000 }, () => false);
  assert.ok(has(p, 1, 2));
  assert.ok(p.images.length > 0);
  assert.match(p.text, /npm test/);
  assert.doesNotMatch(p.text, /SUCCESS_BODY_TO_DROP/);
  assert.deepEqual(items, before);
});

test('clipped structured subagent reports retain exact continuation handles without child thinking', async () => {
  const items = history(80);
  items[1] = reasoning(1);
  items[2] = call('child-report', 'subagent', { agent: 'general', description: 'Inspect the change', prompt: 'Verify it' });
  items[3] = output('child-report', JSON.stringify({
    lead: 'Public lead. '.repeat(600),
    sessionID: 'ses_keep_exact_1234567890',
    content: [{ type: 'thinking', thinking: 'CHILD_PRIVATE_THINKING' }],
    result: 'Public final report. '.repeat(600),
  }));
  const p = await plan(items);
  assert.match(p.text, /ses_keep_exact_1234567890/);
  assert.doesNotMatch(p.text, /CHILD_PRIVATE_THINKING/);
});

test('summary planner is a new export, not a replacement for legacy planners', () => {
  assert.equal(typeof H.planResponsesSummaryCollapse, 'function');
  assert.equal(typeof H.planResponsesPairCollapse, 'function');
});

test('known assistant phases do not pin completed reasoning/tool groups native', async () => {
  for (const phase of ['commentary', 'final_answer']) {
    const items = history(80);
    items[1] = reasoning(1);
    items[2] = { type: 'message', role: 'assistant', id: 'public-message',
      status: 'completed', phase,
      content: [{ type: 'output_text', text: 'Inspect the completed Read.', annotations: [] }] };
    items[3] = call('phase-read');
    items[4] = output('phase-read');
    const before = structuredClone(items);
    const p = await plan(items, { projectionVersion: 2 });
    assert.ok(has(p, 1, 2, 3, 4), `${phase} must not pin the entire closed group`);
    assert.match(p.text, new RegExp(`phase="${phase}"`));
    assert.doesNotMatch(p.text, /successful Read body must disappear/);
    assert.deepEqual(items, before);
    const legacy = await plan(items, { projectionVersion: 1 });
    assert.ok(lacks(legacy, 1, 2, 3, 4), 'old committed envelopes can still be replayed exactly');
    assert.deepEqual(legacy.summaryState.nativeToolPairReasons, { assistant_phase_legacy: 1 });
    assert.deepEqual(p.summaryState.nativeToolPairReasons, {});
  }
});

test('unknown or non-assistant phases still protect the whole protocol group', async () => {
  for (const change of [{ role: 'assistant', phase: 'unknown-phase' },
    { role: 'assistant', phase: 123 }]) {
    const items = history(80);
    items[1] = reasoning(1);
    items[2] = { ...msg(2), ...change };
    items[3] = call('unknown-phase-read');
    items[4] = output('unknown-phase-read');
    const p = await plan(items, { projectionVersion: 2 });
    assert.ok(lacks(p, 1, 2, 3, 4));
  }
  // A new user turn is a real reasoning-group boundary, not part of the
  // previous response. Its invalid phase must stay native independently.
  const items = history(80);
  items[2] = { ...msg(2, 'user'), phase: 'commentary' };
  const p = await plan(items, { projectionVersion: 2 });
  assert.ok(lacks(p, 2));
});

test('only public summaries are labelled; ciphertext never reaches transcript or profitability gate', async () => {
  const items = history(80);
  items[1] = reasoning(1, 'Keep the public conclusion.');
  items[2] = { ...reasoning(2), summary: [{ type: 'text', text: 'Second public note.' }] };
  const before = structuredClone(items);
  let gates = 0;
  const p = await plan(frozen(items), {}, text => {
    gates++;
    assert.doesNotMatch(text, /CIPHERTEXT|encrypted_content/);
    return false;
  });
  assert.ok(has(p, 1, 2), p.reason);
  assert.match(p.text, /<assistant t="1"[^>]*reasoning-summary/);
  assert.match(p.text, /lossy public/);
  assert.match(p.text, /Keep the public conclusion/);
  assert.match(p.text, /Second public note/);
  assert.doesNotMatch(p.text, /CIPHERTEXT|encrypted_content/);
  assert.equal(p.summaryState.removed, 2);
  assert.equal(p.summaryState.summaries, 2);
  assert.equal(p.segments.length, 1, 'summaries share pages with surrounding transcript');
  assert.equal(gates, 0, 'reasoning epochs defer profitability to the whole-request gate');
  assert.deepEqual(items, before);
});

test('absent and empty summaries can remove ciphertext without manufacturing a PNG', async () => {
  const items = native();
  items[1] = { type: 'reasoning', id: 'empty', encrypted_content: 'SECRET', summary: [] };
  items[2] = { type: 'reasoning', id: 'absent', encrypted_content: 'SECRET_2' };
  const p = await plan(items, { maxImages: 0 });
  assert.deepEqual(p.selectedIndices, [1, 2]);
  assert.deepEqual(p.images, []);
  assert.equal(p.text, '');
  assert.equal(p.summaryState.removed, 2);
  assert.equal(p.summaryState.summaries, 0);
});

test('grid zero, bootstrap, explicit cutoffs and the native 30-item tail', async () => {
  for (const [n, opts] of [[79, {}], [130, { checkpointCutoff: 0 }],
    [130, { checkpointCutoff: 49 }], [79, { checkpointBootstrap: true, keepTail: 0 }]]) {
    const p = await plan(history(n), opts);
    assert.deepEqual(p.selectedIndices, []);
    assert.equal(p.summaryState.closedThrough, 0);
  }
  const p = await plan(history(80), { keepTail: 0 });
  assert.ok(p.selectedIndices.length > 0);
  assert.ok(lacks(p, 0), 'retain the original first user task anchor');
  assert.ok(p.selectedIndices.every(i => i < 50));
  assert.equal(p.summaryState.closedThrough, 50);
  const limited = await plan(history(180), { checkpointCutoff: 75 });
  assert.ok(limited.selectedIndices.every(i => i < 50), 'cutoffs limit grid targets, not partial grids');
});

test('later checkpoints append exact old segments/images without repacking source epochs', async () => {
  const items = history(180);
  for (const i of [1, 11, 51, 61, 101, 111]) items[i] = reasoning(i);
  const a = await plan(items.slice(0, 80));
  const b = await plan(items.slice(0, 120));
  const c = await plan(items.slice(0, 130));
  const d = await plan(items);
  assert.deepEqual(b.segments, a.segments);
  assert.deepEqual(c.segments.slice(0, a.segments.length), a.segments);
  assert.deepEqual(d.segments.slice(0, c.segments.length), c.segments);
  assert.ok(c.segments.length > a.segments.length);
  assert.ok(d.segments.length > c.segments.length);
  assert.deepEqual(c.summaryState.epochs.slice(0, 1), a.summaryState.epochs);
  assert.ok(d.selectedIndices.every(i => i < items.length - 30));
});

// Correction: a boundary cut defers a safe unit; it must not pin that unit
// natively forever. Only the next epoch's start moves, never its grid target or
// an already-sealed segment/page.
test('cross-grid reasoning/parallel tool units carry into the next fixed-target epoch', async () => {
  const items = history(130);
  items[47] = reasoning(47);
  items[48] = call('a');
  items[49] = call('b');
  items[50] = output('a');
  items[51] = output('b');
  items[52] = msg(52, 'user');
  const a = await plan(items.slice(0, 80));
  const b = await plan(items);
  assert.equal(a.summaryState.closedThrough, 47);
  assert.ok(lacks(a, 47, 48, 49, 50, 51));
  assert.ok(has(b, 47, 48, 49, 50, 51));
  assert.deepEqual(b.summaryState.epochs.map(e => [e.start, e.target, e.closedThrough]),
    [[0, 50, 47], [47, 100, 100]]);
  assert.equal(b.summaryState.protected, 0, 'deferred reasoning is no longer protected once selected');
  assert.deepEqual(b.segments.slice(0, a.segments.length), a.segments);
});

test('every safe old reasoning before the final safe cut is selected after boundary carry', async () => {
  const items = [msg(0, 'user')];
  for (let i = 0; i < 50; i++) items.push(
    reasoning(items.length), msg(items.length + 1), call(`carry-${i}`), output(`carry-${i}`));
  const a = await plan(items.slice(0, 80));
  const b = await plan(items.slice(0, 130));
  const c = await plan(items.slice(0, 180));
  assert.deepEqual(c.summaryState.epochs.map(e => [e.start, e.target, e.closedThrough]),
    [[0, 50, 49], [49, 100, 97], [97, 150, 149]]);
  for (let i = 0; i < c.summaryState.closedThrough; i++)
    if (items[i].type === 'reasoning')
      assert.ok(has(c, i), `safe historical reasoning at source ${i} must not accumulate`);
  assert.deepEqual(b.segments.slice(0, a.segments.length), a.segments);
  assert.deepEqual(c.segments.slice(0, b.segments.length), b.segments);
  assert.equal(new Set(c.selectedIndices).size, c.selectedIndices.length, 'carry must not reselect old source');
  assert.equal(c.summaryState.protected, 1, 'only the final deferred unit is still protected');
  assert.match(c.text, /<assistant t="49" kind="reasoning-summary"/, 'carried indices remain absolute');
  assert.match(c.text, /<assistant t="51" kind="tool-call"/);
});

test('a still-spanning parallel unit carries across multiple original targets before sealing whole', async () => {
  const items = history(230);
  items[49] = reasoning(49);
  for (let i = 0; i < 60; i++) {
    items[50 + i] = call(`wide-${i}`);
    items[110 + i] = output(`wide-${i}`);
  }
  const a = await plan(items.slice(0, 80));
  const b = await plan(items.slice(0, 130));
  const c = await plan(items.slice(0, 180));
  const d = await plan(items);
  assert.deepEqual(d.summaryState.epochs.map(e => [e.start, e.target, e.closedThrough]),
    [[0, 50, 49], [49, 100, 49], [49, 150, 49], [49, 200, 200]]);
  assert.deepEqual(b.segments, a.segments);
  assert.deepEqual(c.segments, a.segments);
  assert.deepEqual(d.segments.slice(0, a.segments.length), a.segments);
  assert.ok(has(d, ...Array.from({ length: 121 }, (_, i) => i + 49)));
  assert.equal(d.summaryState.removed, 1);
  assert.equal(d.summaryState.protected, 0);
  assert.equal(d.pairState.collapsedPairs, 60);
});

test('safe parallel rounds collapse atomically and retain failure evidence but not Read bodies', async () => {
  const items = history(80);
  items[1] = reasoning(1);
  items[2] = call('a');
  items[3] = call('b', 'shell', { command: 'npm test' });
  items[4] = output('b', 'Error: test failed with exit code 1');
  items[5] = output('a');
  items[6] = msg(6, 'user');
  const p = await plan(items);
  assert.ok(has(p, 1, 2, 3, 4, 5));
  assert.equal(p.pairState.collapsedPairs, 2);
  assert.match(p.text, /\[Read\] \/source\/a.js/);
  assert.match(p.text, /\[shell error\].*test failed/);
  assert.match(p.text, /<assistant t="2"/);
  assert.match(p.text, /<tool t="4"/);
  assert.doesNotMatch(p.text, /successful Read body/);
});

test('open, orphan, malformed, referenced and partially native parallel responses retain associated reasoning', async () => {
  const cases = [
    [call('open')],
    [output('orphan')],
    [call('bad'), { ...output('bad'), status: 'in_progress' }],
    [{ ...call('bad'), arguments: '{not JSON' }, output('bad')],
    [call('dup'), call('dup'), output('dup')],
    [call('ref'), { ...output('ref'), id: 'referenced-output' },
      { type: 'item_reference', id: 'referenced-output' }],
    [call('a'), call('b'), output('a'), { ...output('b'), output: [{ type: 'input_file', file_id: 'file' }] }],
  ];
  for (const block of cases) {
    const items = native();
    items[1] = reasoning(1);
    block.forEach((v, i) => { items[i + 2] = v; });
    const p = await plan(items);
    assert.ok(lacks(p, 1, ...block.map((_, i) => i + 2)), JSON.stringify(block));
    assert.equal(p.summaryState.removed, 0);
    assert.equal(p.summaryState.protected, 1);
  }
});

test('all original image pixels/rendered context, authorities, unknown and referenced messages remain native', async () => {
  const items = history(130);
  const image = { type: 'input_image', image_url: 'data:image/png;base64,ORIGINAL_PIXELS' };
  items[3] = { role: 'user', content: [{ type: 'input_text', text: 'screenshot' }, image] };
  items[5] = reasoning(5);
  items[6] = call('image');
  items[7] = output('image', [image]);
  items[8] = msg(8, 'user');
  items[10] = { role: 'user', content: [{ type: 'input_text', text: '[End of rendered GPT system/tool context.]' }, image] };
  items[12] = { role: 'developer', content: 'authoritative developer' };
  items[14] = { role: 'system', content: 'authoritative system' };
  items[16] = { type: 'unknown_native', text: 'must not project this' };
  items[18] = { role: 'assistant', content: [{ type: 'future_unknown', text: 'unknown is not plain text' }] };
  items[20] = { ...msg(20), id: 'ref20' };
  items[21] = { type: 'item_reference', item_id: 'ref20' };
  const before = structuredClone(items);
  const p = await plan(frozen(items));
  assert.ok(lacks(p, 0, 3, 5, 6, 7, 10, 12, 14, 16, 18, 20, 21));
  assert.doesNotMatch(p.text, /ORIGINAL_PIXELS|authoritative|unknown is not plain text/);
  assert.deepEqual(items, before);
});

test('subagent reports/handles survive, typed child thinking does not, arbitrary business prose stays intact', async () => {
  const items = native();
  items[1] = reasoning(1);
  items[2] = call('child', 'task', { description: 'check result', prompt: 'test' });
  items[3] = output('child', JSON.stringify({
    sessionID: 'session-keep', agent_id: 'agent-keep',
    content: [{ type: 'thinking', thinking: 'CHILD_PRIVATE_THINKING' },
      { type: 'reasoning', text: 'CHILD_PRIVATE_REASONING' },
      { type: 'text', text: 'Final report: reasoning about business thinking is valid prose.' }],
  }));
  const p = await plan(items);
  assert.ok(has(p, 1, 2, 3));
  assert.match(p.text, /session-keep/);
  assert.match(p.text, /agent-keep/);
  assert.match(p.text, /Final report: reasoning about business thinking is valid prose/);
  assert.doesNotMatch(p.text, /CHILD_PRIVATE/);
  const launch = native();
  launch[1] = call('launch', 'task');
  launch[2] = output('launch', 'Async agent launched. sessionID=session-launch-keep');
  assert.match((await plan(launch)).text, /session-launch-keep/);
});

test('structured continuation handles survive the clipped middle of a long subagent report', async () => {
  const items = native();
  items[1] = reasoning(1);
  items[2] = call('long-child', 'task');
  items[3] = output('long-child', JSON.stringify({
    head: 'Final report: business thinking and reasoning stay ordinary prose. ' + 'a'.repeat(4500),
    sessionID: 'middle-session-camel', session_id: 'middle-session-snake',
    agent_id: 'middle-agent', task_id: 'middle-task',
    resume: 'middle-resume', handle: 'middle-handle',
    content: [{ type: 'thinking', thinking: 'LONG_CHILD_PRIVATE_THINKING' },
      { type: 'reasoning', text: 'LONG_CHILD_PRIVATE_REASONING' }],
    ignored: { handle: 'OVERSIZE_HANDLE_' + 'x'.repeat(1024) },
    tail: 'z'.repeat(4500) + ' Public final result.',
  }));
  const p = await plan(items);
  assert.ok(has(p, 1, 2, 3));
  assert.match(p.text, /\[Subagent continuation handles\]/);
  const continuation = p.text.split('[Subagent continuation handles]')[1];
  for (const value of ['middle-session-camel', 'middle-session-snake',
    'middle-agent', 'middle-task', 'middle-resume', 'middle-handle'])
    assert.ok(continuation.includes(value), value);
  assert.match(p.text, /business thinking and reasoning stay ordinary prose/);
  assert.match(p.text, /Public final result/);
  assert.match(p.text, /chars omitted/, 'the report itself still uses existing clipping policy');
  assert.doesNotMatch(p.text, /LONG_CHILD_PRIVATE/);
  assert.doesNotMatch(continuation, /OVERSIZE_HANDLE/);
});

test('budget exhaustion is explicit and atomic, including an already-sealed earlier source epoch', async () => {
  const items = history(130);
  items[1] = reasoning(1);
  items[51] = reasoning(51);
  const first = await plan(items.slice(0, 80));
  assert.ok(first.images.length > 0);
  const p = await plan(items, { maxImages: first.images.length });
  assert.equal(p.reason, 'summary_image_budget');
  assert.deepEqual(p.selectedIndices, []);
  assert.deepEqual(p.segments, []);
  assert.deepEqual(p.images, []);
  assert.equal(p.summaryState.removed, 0);
  const zero = await plan(items, { maxImages: 0 });
  assert.equal(zero.reason, 'summary_image_budget');
  assert.deepEqual(zero.selectedIndices, []);
});

test('null/malformed input and limits fail safe; pure text uses the profitability gate', async () => {
  for (const input of [null, undefined, {}, 'not an item array', []])
    assert.deepEqual((await plan(input)).selectedIndices, []);
  const items = native();
  const malformed = [null, { type: 'reasoning', summary: null }, { type: 'reasoning', summary: [{ type: 'summary_text', text: 12 }] },
    { type: 'reasoning', summary: [{ type: 'unknown', text: 'not a public summary' }] },
    { role: 'assistant', content: [null] }, { role: 'assistant', content: { text: 'malformed' } }];
  malformed.forEach((v, i) => { items[i + 1] = v; });
  assert.deepEqual((await plan(items)).selectedIndices, []);
  let gates = 0;
  const text = await plan(history(80), {}, () => { gates++; return false; });
  assert.deepEqual(text.selectedIndices, []);
  assert.ok(gates > 0);
  const tail = await plan(history(130), { keepTail: 1000 });
  assert.deepEqual(tail.selectedIndices, []);
  const limited = await plan(history(130), { maxImages: -1 });
  assert.equal(limited.reason, 'summary_image_budget');
});

test('checkpointChunk <=1 disables summary; configured integer grids are honored, defaulting to 50', async () => {
  // Correction: configured small grids are not silently clamped to 50.
  for (const checkpointChunk of [0, -1, 1]) {
    const p = await plan(history(130), { checkpointChunk });
    assert.deepEqual(p.selectedIndices, [], `checkpointChunk=${checkpointChunk} disables summary`);
    assert.deepEqual(p.summaryState.epochs, []);
  }
  for (const checkpointChunk of [NaN, Infinity]) {
    const p = await plan(history(79), { checkpointChunk });
    assert.deepEqual(p.selectedIndices, [], `checkpointChunk=${checkpointChunk}`);
  }
  for (const checkpointChunk of [2, 10, 50, 100]) {
    const short = await plan(history(checkpointChunk + 29), { checkpointChunk });
    assert.deepEqual(short.selectedIndices, [], 'still requires a full configured chunk plus 30 raw tail');
    const p = await plan(history(checkpointChunk + 30), { checkpointChunk });
    assert.deepEqual(p.selectedIndices, Array.from({ length: checkpointChunk - 1 }, (_, i) => i + 1));
    assert.deepEqual(p.summaryState.epochs.map(e => e.target), [checkpointChunk]);
  }
});

test('a native/malformed call cannot split an otherwise adjacent parallel batch into a selected suffix', async () => {
  const items = native();
  items[1] = { ...call('open'), arguments: 'malformed' };
  items[2] = call('closed');
  items[3] = output('closed');
  const p = await plan(items);
  assert.deepEqual(p.selectedIndices, []);
});

test('opaque message/tool fields and a synthetic initial context cannot displace the true task anchor', async () => {
  const items = history(80);
  items[0] = { role: 'user', content: [{ type: 'input_text', text: '[End of rendered GPT system/tool context.]' }] };
  items[1] = msg(1, 'user');
  items[3] = { ...msg(3), tool_calls: [{ id: 'native-call' }] };
  items[5] = { ...call('opaque'), opaque_state: 'must remain native' };
  items[6] = output('opaque');
  const p = await plan(items);
  assert.ok(lacks(p, 0, 1, 3, 5, 6));
});

test('a summary-only history advances the source grid without retaining a separate opaque reservoir', async () => {
  const items = [msg(0, 'user'), ...Array.from({ length: 120 }, (_, i) =>
    ({ type: 'reasoning', id: `only-${i}`, summary: [], encrypted_content: `opaque-${i}` }))];
  const p = await plan(items, { maxImages: 0 });
  assert.deepEqual(p.selectedIndices, Array.from({ length: 49 }, (_, i) => i + 1));
  assert.equal(p.summaryState.removed, 49);
  assert.equal(p.summaryState.closedThrough, 50);
  assert.deepEqual(p.images, []);
});

test('a newly appended reference to sealed source fails safe instead of repacking an old epoch', async () => {
  const items = history(80);
  items[3] = { ...msg(3), id: 'late-reference-target' };
  const first = await plan(items);
  assert.ok(has(first, 3));
  const second = await plan([...items, { type: 'item_reference', id: 'late-reference-target' }]);
  assert.equal(second.reason, 'summary_native_reference');
  assert.deepEqual(second.segments, []);
  assert.deepEqual(second.selectedIndices, []);
});

test('pair telemetry covers the whole request, including state beyond the last epoch snapshot', async () => {
  const items = [msg(0, 'user'), ...Array.from({ length: 60 }, (_, i) =>
    [call(`telemetry-${i}`), output(`telemetry-${i}`)]).flat(), call('open-tail'), output('orphan-tail')];
  const p = await plan(items, {}, () => false);
  assert.equal(p.pairState.completedPairs, 60);
  assert.equal(p.pairState.openCalls, 1);
  assert.equal(p.pairState.orphanOutputs, 1);
  assert.deepEqual(p.selectedIndices, []);
});

test('bounded epochs retain duplicate IDs and adjacent native parallel state from before their source start', async () => {
  for (const earlier of [[call('duplicate'), output('duplicate')], [output('duplicate')]]) {
    const items = native(130);
    earlier.forEach((item, i) => { items[i + 1] = item; });
    items[51] = reasoning(51);
    items[52] = call('duplicate');
    items[53] = output('duplicate');
    const p = await plan(items);
    assert.ok(lacks(p, 51, 52, 53), 'a local pair is not safe if the prefix contains duplicate call/output IDs');
    assert.equal(p.summaryState.protected, 1);
  }
  const items = native(130);
  items[49] = call('open-native');
  items[50] = call('parallel-suffix');
  items[51] = output('parallel-suffix');
  assert.deepEqual((await plan(items)).selectedIndices, []);
});
