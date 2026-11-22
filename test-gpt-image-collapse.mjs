// Regression: old client images must not be permanent history barriers.
// Only selected checkpoint ranges may lose pixels. No API, files or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const H = await import(core + 'openai-history.js');
const O = await import(core + 'openai.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const OLD = `data:image/png;base64,${PNG}`;
const RECENT = 'https://example.invalid/recent.png';
const chatImage = (url = OLD) => ({ type: 'image_url', image_url: { url } });
const respImage = (url = OLD) => ({ type: 'input_image', image_url: url });
const text = (i, n = 16) => Array.from({ length: n }, (_, j) =>
  `Turn ${i} line ${j}: inspect the layout and describe the button position before changing the CSS; step ${i * 11 + j}.`).join('\n');
const cm = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: text(i) });
const rm = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: [{ type: i % 2 ? 'output_text' : 'input_text', text: text(i) }] });
const options = { keepTail: 4, keepRecentPairs: 2, minCollapsePrefix: 1, minCollapseTokens: 0,
  collapseChunk: 1, freezeChunk: 1, sectionTokens: 700, maxImages: 80, responsesMode: 'mixed' };

test('Chat lowering: known images become markers for collapse, not barriers; recall mode still has a barrier', () => {
  const message = { role: 'user', content: [{ type: 'text', text: 'old UI' }, chatImage()] };
  const original = structuredClone(message);
  const [turn] = H.chatMessagesToTurns([message], { dropTools: true, collapseImages: true });
  assert.equal(turn.opaque, false);
  assert.match(turn.text, /\[image/);
  assert.doesNotMatch(turn.text, /base64|iVBOR/);
  assert.equal(H.chatMessagesToTurns([message])[0].opaque, true);
  assert.deepEqual(message, original);
});

test('Chat planner: an old image near the beginning no longer stops the entire prefix', async () => {
  const messages = Array.from({ length: 20 }, (_, i) => cm(i));
  messages[2].content = [{ type: 'text', text: text(2) }, chatImage()];
  const turns = H.chatMessagesToTurns(messages, { dropTools: true, collapseImages: true });
  const plan = await H.planGptCollapse(turns, 0, () => true, options);
  assert.ok(plan.endExclusive > 8, `must cross old image: ${plan.endExclusive}, ${plan.reason}`);
  assert.match(plan.text, /\[image/);
  assert.ok(plan.endExclusive <= messages.length - options.keepTail);
});

test('Chat Read image: closed call/result may collapse together; call path and image marker survive', async () => {
  const messages = [{ role: 'user', content: 'inspect UI' }];
  for (let i = 0; i < 10; i++) messages.push(
    { role: 'assistant', content: text(i), tool_calls: [{ id: `c${i}`, function: { name: 'Read', arguments: JSON.stringify({ path: `C:/tmp/ui-${i}.png` }) } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: [{ type: 'text', text: 'image read' }, chatImage()] },
  );
  const plan = await H.planGptCollapse(H.chatMessagesToTurns(messages, { dropTools: true, collapseImages: true }), 0, () => true, options);
  assert.ok(plan.endExclusive > 5, plan.reason);
  assert.match(plan.text, /C:\/tmp\/ui-0\.png/);
  assert.match(plan.text, /\[image/);
  assert.doesNotMatch(plan.text, /iVBOR|base64/);
  const open = new Set();
  for (const m of messages.slice(plan.endExclusive)) {
    for (const c of m.tool_calls ?? []) open.add(c.id);
    if (m.role === 'tool') { assert.ok(open.has(m.tool_call_id)); open.delete(m.tool_call_id); }
  }
  assert.equal(open.size, 0);
});

test('Chat: unknown non-image payload remains a barrier', () => {
  const [turn] = H.chatMessagesToTurns([{ role: 'user', content: [
    { type: 'text', text: 'audio' }, { type: 'input_audio', input_audio: { data: 'SECRET', format: 'wav' } },
  ] }], { collapseImages: true });
  assert.equal(turn.opaque, true);
});

test('Responses mixed: old image messages join the same run; latest user image stays native', async () => {
  const items = Array.from({ length: 20 }, (_, i) => rm(i));
  items[2].content.push(respImage());
  items.push({ role: 'user', content: [{ type: 'input_text', text: 'new screenshot question' }, respImage(RECENT)] });
  const before = structuredClone(items);
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0 });
  assert.ok(plan.selectedIndices.includes(2), 'old image must be selected');
  assert.equal(plan.segments.length, 1, 'image must not split the old run');
  assert.ok(!plan.selectedIndices.includes(items.length - 1), 'latest image question stays native');
  assert.match(plan.text, /\[image/);
  assert.doesNotMatch(plan.text, /iVBOR|base64/);
  assert.deepEqual(items, before);
});

test('Responses: referenced image and unknown file payload stay native', async () => {
  const items = Array.from({ length: 18 }, (_, i) => rm(i));
  items[2] = { id: 'ref-image', role: 'user', content: [respImage()] };
  items[4] = { role: 'user', content: [{ type: 'input_file', file_id: 'file-must-survive' }] };
  items.push({ type: 'item_reference', id: 'ref-image' }, rm(18));
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0 });
  assert.ok(plan.selectedIndices.length > 0);
  assert.ok(!plan.selectedIndices.includes(2));
  assert.ok(!plan.selectedIndices.includes(4));
  assert.ok(!plan.selectedIndices.includes(18));
});

test('Responses custom tool: old image output is imageable, while file output is still native', async () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(
    { type: 'custom_tool_call', call_id: `custom${i}`, name: 'Read', input: `C:/tmp/custom-${i}.png` },
    { type: 'custom_tool_call_output', call_id: `custom${i}`, output: [{ type: 'input_text', text: text(i) }, respImage()] },
  );
  items.splice(4, 0, { type: 'custom_tool_call', call_id: 'file', name: 'Read', input: 'other' },
    { type: 'custom_tool_call_output', call_id: 'file', output: [{ type: 'input_file', file_id: 'file-native', text: 'caption is not the file' }] });
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0, keepRecentPairs: 1 });
  assert.ok(plan.selectedIndices.includes(0), 'custom image output must not be a barrier');
  assert.ok(plan.selectedIndices.includes(1));
  assert.ok(!plan.selectedIndices.includes(4) && !plan.selectedIndices.includes(5));
  assert.match(plan.text, /C:\/tmp\/custom-0\.png/, 'raw custom tool input keeps the source path');
  assert.match(plan.text, /\[image/);
  assert.doesNotMatch(plan.text, /iVBOR|base64/);
});

test('Responses function tool: unknown file payload remains native even with a completed call', async () => {
  const items = [];
  for (let i = 0; i < 8; i++) items.push(
    { type: 'function_call', call_id: `file${i}`, name: 'Read', arguments: '{}' },
    { type: 'function_call_output', call_id: `file${i}`, output: i === 0
      ? [{ type: 'input_file', file_id: 'must-not-disappear', text: 'caption is not the file' }] : text(i) },
  );
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0 });
  assert.ok(plan.selectedIndices.length > 0);
  assert.ok(!plan.selectedIndices.includes(0) && !plan.selectedIndices.includes(1));
});

test('Responses custom tool image chain uses the same live-tail floors as function tools', () => withEnv({
  PXLITE_TOOL_ROUND_CUT: undefined, PXLITE_GPT_KEEP_TAIL: undefined, PXLITE_TOOL_ROUND_KEEP_TAIL: undefined,
}, () => {
  const floors = O.pxliteTailFloors([
    { type: 'custom_tool_call', call_id: 'live', name: 'Read', input: 'C:/tmp/live.png' },
    { type: 'custom_tool_call_output', call_id: 'live', output: [respImage(RECENT)] },
  ]);
  assert.equal(floors.keepTail, 12);
  assert.equal(floors.keepRecentPairs, 6);
}));

test('Image markers keep supplied source paths/URLs, never inline base64', async () => {
  const items = Array.from({ length: 12 }, (_, i) => rm(i));
  items[0].content.push(respImage('file:///C:/tmp/old-ui.png'), respImage());
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0 });
  assert.match(plan.text, /file:\/\/\/C:\/tmp\/old-ui\.png/);
  assert.doesNotMatch(plan.text, /iVBOR|data:image/);
});

test('Frozen Chat sections containing images do not change when later requests are appended', async () => {
  const messages = Array.from({ length: 30 }, (_, i) => cm(i));
  messages[2].content = [{ type: 'text', text: text(2) }, chatImage()];
  messages[8].content = [{ type: 'text', text: text(8) }, chatImage('file:///C:/tmp/8.png')];
  const plan = (list) => H.planGptCollapse(H.chatMessagesToTurns(list, { collapseImages: true }), 0, () => true, options);
  const a = await plan(messages.slice(0, 20));
  const b = await plan(messages);
  assert.ok(a.imageSources.length > 1);
  assert.deepEqual(b.imageSources.slice(0, a.imageSources.length), a.imageSources);
  assert.deepEqual(b.images.slice(0, a.images.length).map((i) => i.png), a.images.map((i) => i.png));
});

test('Frozen Responses sections containing images stay identical across later requests', async () => {
  const items = Array.from({ length: 30 }, (_, i) => rm(i));
  items[2].content.push(respImage());
  items[8].content.push(respImage('file:///C:/tmp/8.png'));
  const plan = (list) => H.planResponsesPairCollapse(list, () => true, options);
  const a = await plan(items.slice(0, 20));
  const b = await plan(items);
  assert.ok(a.imageSources.length > 1);
  assert.deepEqual(b.imageSources.slice(0, a.imageSources.length), a.imageSources);
  assert.deepEqual(b.images.slice(0, a.images.length).map((i) => i.png), a.images.map((i) => i.png));
});

test('Responses: tool calls without a matching completed output stay native beside old images', async () => {
  const items = Array.from({ length: 18 }, (_, i) => rm(i));
  items[2].content.push(respImage());
  items.splice(6, 0, { type: 'function_call', call_id: 'pending', name: 'Read', arguments: '{}' });
  const plan = await H.planResponsesPairCollapse(items, () => true, { ...options, freezeChunk: 0 });
  assert.ok(plan.selectedIndices.includes(2));
  assert.ok(!plan.selectedIndices.includes(6), 'never swallow the unresolved call');
});

const env = { ...GATE_ENV_OFF, PXLITE_READ_NOTE: 'off', PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0 };
const enc = (v) => new TextEncoder().encode(JSON.stringify(v));
const dec = (v) => JSON.parse(new TextDecoder().decode(v));
for (const mode of ['chat', 'responses']) {
  test(`${mode} integration: static-slab pixels survive, old client pixels drop, latest pixels and original input survive`, () => withEnv(env, async () => {
    const messages = Array.from({ length: 30 }, (_, i) => mode === 'chat' ? cm(i) : rm(i));
    if (mode === 'chat') messages[2].content = [{ type: 'text', text: text(2) }, chatImage()];
    else messages[2].content.push(respImage());
    messages.push({ role: 'user', content: [{ type: mode === 'chat' ? 'text' : 'input_text', text: 'inspect latest UI' },
      mode === 'chat' ? chatImage(RECENT) : respImage(RECENT)] });
    const body = mode === 'chat'
      ? { model: 'gpt-6.2-sol', messages: [{ role: 'system', content: text(100, 80) }, ...messages] }
      : { model: 'gpt-6.2-sol', instructions: text(100, 80), input: messages };
    const bytes = enc(body);
    const run = mode === 'chat' ? O.transformOpenAIChatCompletions : O.transformOpenAIResponses;
    const r = await run(bytes, { gptHistory: { sectionTokens: 700 } });
    assert.equal(r.info.historyReason, 'collapsed');
    const out = dec(r.body);
    const str = JSON.stringify(out);
    assert.ok(!str.includes(OLD), 'old native image removed by checkpoint');
    assert.ok(str.includes(RECENT), 'live pixels must survive');
    const key = mode === 'chat' ? 'messages' : 'input';
    const slab = out[key].find((m) => m.content?.some?.((p) => p.text === '[End of rendered GPT system/tool context.]'));
    assert.ok(slab?.content.some((p) => p.type === (mode === 'chat' ? 'image_url' : 'input_image')),
      'never replace system/tool slab with [image]');
    assert.match(r.info.imageSourceTexts.join('\n'), /\[image/);
    assert.equal(new TextDecoder().decode(bytes), JSON.stringify(body));
  }));

  test(`${mode} integration: recalled text images remain readable, later screenshots can collapse`, () => withEnv(env, async () => {
    const recalled = mode === 'chat' ? chatImage('file:///C:/tmp/rendered-recall.png') : respImage('file:///C:/tmp/rendered-recall.png');
    const messages = [{ role: 'user', content: [
      { type: mode === 'chat' ? 'text' : 'input_text', text: '[pxlite recall: immutable recalled text follows]' }, recalled,
    ] }, ...Array.from({ length: 30 }, (_, i) => mode === 'chat' ? cm(i) : rm(i))];
    if (mode === 'chat') messages[3].content = [{ type: 'text', text: text(2) }, chatImage()];
    else messages[3].content.push(respImage());
    messages.push({ role: 'user', content: mode === 'chat' ? 'continue' : [{ type: 'input_text', text: 'continue' }] });
    const body = { model: 'gpt-6.2-sol', [mode === 'chat' ? 'messages' : 'input']: messages };
    const run = mode === 'chat' ? O.transformOpenAIChatCompletions : O.transformOpenAIResponses;
    const r = await run(enc(body), { gptHistory: { sectionTokens: 700 } });
    assert.equal(r.info.historyReason, 'collapsed');
    const wire = JSON.stringify(dec(r.body));
    assert.ok(wire.includes('file:///C:/tmp/rendered-recall.png'), 'keep actual recall pixels');
    assert.ok(!wire.includes(OLD), 'old screenshot after recall no longer blocks collapse');
  }));
}

test('Chat without a static slab: an image in the original opening prompt can collapse', () => withEnv(env, async () => {
  const messages = Array.from({ length: 30 }, (_, i) => cm(i));
  messages[0].content = [{ type: 'text', text: text(0) }, chatImage()];
  messages.push({ role: 'user', content: 'continue' });
  const r = await O.transformOpenAIChatCompletions(enc({ model: 'gpt-6.2-sol', messages }), { gptHistory: { sectionTokens: 700 } });
  assert.equal(r.info.historyReason, 'collapsed');
  assert.ok(!JSON.stringify(dec(r.body)).includes(OLD));
}));
