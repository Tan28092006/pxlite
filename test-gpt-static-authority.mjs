// Offline regression for static-slab authority ordering and cache stability.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';

// Exercise the overlay itself without changing the shared vendor junction.
const vendor = path.resolve('vendor/pxpipe-proxy');
const tmp = fs.mkdtempSync(path.resolve('.static-authority-test-'));
const copy = path.join(tmp, 'vendor/pxpipe-proxy');
fs.mkdirSync(copy, { recursive: true });
fs.cpSync(path.join(vendor, 'dist'), path.join(copy, 'dist'), { recursive: true });
fs.copyFileSync(path.join(vendor, 'package.json'), path.join(copy, 'package.json'));
fs.cpSync(path.join(vendor, 'node_modules'), path.join(copy, 'node_modules'), { recursive: true });
for (const file of ['tool-lines.mjs', 'collapse-tools.mjs']) fs.copyFileSync(file, path.join(tmp, file));
fs.copyFileSync('overlay/dist/core/openai.js', path.join(copy, 'dist/core/openai.js'));
fs.copyFileSync('overlay/dist/core/openai-history.js', path.join(copy, 'dist/core/openai-history.js'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const core = await import(pathToFileURL(path.join(copy, 'dist/core/openai.js')));
const history = await import(pathToFileURL(path.join(copy, 'dist/core/openai-history.js')));
const encode = (x) => new TextEncoder().encode(JSON.stringify(x));
const staticText = Array.from({ length: 600 }, (_, i) =>
  `Opening instruction ${i}: inspect the project carefully and preserve all relevant details.`).join('\n');
const opts = { collapseHistory: false, compressTools: false, minCompressChars: 1, charsPerToken: 1 };

for (const api of ['responses', 'chat']) {
  const transform = api === 'responses' ? core.transformOpenAIResponses : core.transformOpenAIChatCompletions;
  const field = api === 'responses' ? 'input' : 'messages';
  const user = { role: 'user', content: 'initial user question' };
  const base = [{ role: 'developer', content: staticText }, user, { role: 'assistant', content: 'initial answer' }];
  const run = async (items) => {
    const r = await transform(encode({ model: 'gpt-6.2-sol', [field]: items }), opts);
    assert.ok(r.info.compressed, `expected slab: ${r.info.reason}`);
    return { wire: JSON.parse(new TextDecoder().decode(r.body))[field], info: r.info };
  };
  test(`${api}: appended, edited and deleted later developer instructions do not rewrite slab`, async () => {
    const original = await run(base);
    const later = { role: 'developer', content: 'LATER AUTHORITY one' };
    const appended = await run([...base, later, { role: 'user', content: 'follow up' }]);
    const edited = await run([...base, { ...later, content: 'LATER AUTHORITY edited' }, { role: 'user', content: 'follow up' }]);
    const deleted = await run([...base, { role: 'user', content: 'follow up' }]);
    for (const r of [appended, edited, deleted]) {
      assert.equal(r.info.imageSourceText, original.info.imageSourceText);
      assert.deepEqual(r.wire.slice(0, original.wire.length), original.wire);
      assert.doesNotMatch(r.info.imageSourceText, /LATER AUTHORITY/);
    }
    assert.deepEqual(appended.wire.at(-2), later);
    assert.equal(edited.wire.at(-2).content, 'LATER AUTHORITY edited');
    assert.equal(deleted.wire.at(-1).content, 'follow up');
  });
  test(`${api}: editing or deleting opening authority rebuilds the slab`, async () => {
    const original = await run(base);
    const changed = await run([{ ...base[0], content: staticText + '\nCHANGED OPENING' }, ...base.slice(1)]);
    assert.notEqual(changed.info.imageSourceText, original.info.imageSourceText);
    assert.match(changed.info.imageSourceText, /CHANGED OPENING/);
    const result = await transform(encode({ model: 'gpt-6.2-sol', [field]: base.slice(1) }), opts);
    assert.equal(result.info.compressed, false);
  });
  test(`${api}: later system and multipart developer stay native and in order`, async () => {
    const multipart = { role: 'developer', content: api === 'responses'
      ? [{ type: 'input_text', text: 'later developer parts' }]
      : [{ type: 'text', text: 'later developer parts' }] };
    const laterSystem = { role: 'system', content: 'later system text' };
    const r = await run([...base, multipart, laterSystem, user]);
    assert.deepEqual(r.wire.slice(-3), [multipart, laterSystem, user]);
    assert.doesNotMatch(r.info.imageSourceText, /later developer parts|later system text/);
  });
  test(`${api}: non-authority before first user prevents authority relocation`, async () => {
    const items = [base[0], { role: 'assistant', content: 'barrier' }, user];
    const r = await transform(encode({ model: 'gpt-6.2-sol', [field]: items }), opts);
    assert.equal(r.info.compressed, false);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body))[field], items);
  });
  test(`${api}: mixed opening content is not stripped or reordered`, async () => {
    const part = api === 'responses' ? { type: 'input_text', text: staticText }
      : { type: 'text', text: staticText };
    const items = [{ role: 'developer', content: [part, { type: 'opaque', value: 'keep' }] }, user];
    const r = await transform(encode({ model: 'gpt-6.2-sol', [field]: items }), opts);
    assert.equal(r.info.compressed, false);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body))[field], items);
  });
}

const historyEnv = { ...GATE_ENV_OFF, PXLITE_READ_NOTE: 'off',
  PXLITE_MIN_COLLAPSE_MESSAGES: 0, PXLITE_GPT_MIN_COLLAPSE_TOKENS: 0 };
const historyText = i => (`History turn ${i}: inspect the source, verify the changes, and retain evidence.\n`).repeat(28);
const decoded = r => JSON.parse(new TextDecoder().decode(r.body));
const slabMarker = item => Array.isArray(item.content) &&
  item.content.some(p => p.text === '[End of rendered GPT system/tool context.]');

test('Responses summary checkpoint preserves late authority and metadata in serialized order', () =>
  withEnv(historyEnv, async () => {
    const opening = { role: 'developer', content: staticText };
    const authority = [
      { type: 'message', id: 'dev-before', role: 'developer',
        content: [{ type: 'input_text', text: 'developer before checkpoint', annotations: [{ tag: 'retain' }] }],
        metadata: { revision: 1 } },
      { type: 'message', id: 'system-at', role: 'system', content: 'system at checkpoint',
        metadata: { revision: 2 } },
      { type: 'message', id: 'dev-after', role: 'developer',
        content: [{ type: 'input_text', text: 'developer after checkpoint' },
          { type: 'input_image', image_url: 'https://example.invalid/native.png', detail: 'high' }],
        metadata: { revision: 3 } },
    ];
    const items = [opening, ...Array.from({ length: 150 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: historyText(i),
    }))];
    // The summary checkpoint is source index 100; place authority on both
    // sides, including the exact boundary item (which remains outside it).
    items[25] = authority[0];
    items[100] = authority[1];
    items[101] = authority[2];
    const body = { model: 'gpt-6.1-sol', input: items };
    const historyOptions = {
      ...opts, collapseHistory: true,
      gptHistory: { reasoningMode: 'summary', checkpointChunk: 50, keepTail: 30,
        keepRecentPairs: 0, maxImages: 160, sectionTokens: 900, minCollapseTokens: 0,
        minCollapsePrefix: 0, preserveClientImages: true,
        cacheGate: { evaluate: x => ({ accept: true, history_mode: 'summary', chosen_cutoff: x.candidateCutoff }) } },
    };
    const r = await core.transformOpenAIResponses(encode(body), historyOptions);
    assert.equal(r.info.gptCacheGate?.chosen_cutoff, 100);
    assert.equal(r.info.gptCacheGate?.wire_applied, true);
    const wire = decoded(r).input;
    assert.ok(wire.length < items.length, 'history actually collapsed');
    const positions = authority.map(a => wire.findIndex(item => item.id === a.id));
    const slab = wire.findIndex(slabMarker);
    assert.ok(slab >= 0 && positions[0] > slab);
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2]);
    for (let i = 0; i < authority.length; i++) assert.deepEqual(wire[positions[i]], authority[i]);
    assert.deepEqual(wire.slice(-30), items.slice(-30), 'live tail remains in order');
    assert.doesNotMatch(r.info.imageSourceText, /developer before checkpoint|system at checkpoint|developer after checkpoint/);
    for (const action of ['edit', 'delete']) {
      const changed = structuredClone(items);
      if (action === 'edit') changed[25].content[0].text = 'edited developer before checkpoint';
      else changed.splice(25, 1);
      const next = await core.transformOpenAIResponses(encode({ ...body, input: changed }), historyOptions);
      const nextWire = decoded(next).input;
      assert.equal(next.info.gptCacheGate?.wire_applied, true);
      assert.equal(next.info.imageSourceText, r.info.imageSourceText, 'opening slab remains stable');
      assert.deepEqual(nextWire.slice(0, nextWire.findIndex(slabMarker) + 1),
        wire.slice(0, wire.findIndex(slabMarker) + 1));
      const dev = nextWire.find(item => item.id === 'dev-before');
      if (action === 'edit') assert.deepEqual(dev, changed[25]);
      else assert.equal(dev, undefined);
      const sys = nextWire.findIndex(item => item.id === 'system-at');
      const later = nextWire.findIndex(item => item.id === 'dev-after');
      assert.ok(sys >= 0 && sys < later);
      assert.deepEqual(nextWire[sys], authority[1]);
      assert.deepEqual(nextWire[later], authority[2]);
    }
  }));

test('Chat history collapse retains late authority, mixed content and metadata in wire order', () =>
  withEnv(historyEnv, async () => {
    const authority = [
      { role: 'developer', name: 'late_dev', content: [
        { type: 'text', text: 'late developer text', metadata: { keep: true } },
        { type: 'image_url', image_url: { url: 'https://example.invalid/late.png', detail: 'high' } },
      ] },
      { role: 'system', name: 'late_system', content: 'late system text', metadata: { revision: 2 } },
    ];
    const messages = [{ role: 'system', content: staticText },
      ...Array.from({ length: 45 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user', content: historyText(i),
      }))];
    messages.splice(25, 0, ...authority);
    const r = await core.transformOpenAIChatCompletions(encode({ model: 'gpt-6.2-sol', messages }),
      { ...opts, collapseHistory: true, gptHistory: { sectionTokens: 700 } });
    assert.equal(r.info.historyReason, 'collapsed');
    const wire = decoded(r).messages;
    assert.ok(wire.length < messages.length, 'history actually collapsed');
    const dev = wire.findIndex(item => item.name === 'late_dev');
    const sys = wire.findIndex(item => item.name === 'late_system');
    assert.ok(dev > wire.findIndex(slabMarker) && sys === dev + 1,
      `late authority must remain native after the slab; slab=${wire.findIndex(slabMarker)} dev=${dev} sys=${sys}`);
    assert.deepEqual(wire[dev], authority[0]);
    assert.deepEqual(wire[sys], authority[1]);
    assert.deepEqual(wire.slice(dev), messages.slice(messages.indexOf(authority[0])),
      'the entire native suffix beginning at the authority barrier stays in place');
    assert.deepEqual(wire.slice(-4), messages.slice(-4));
    assert.doesNotMatch((r.info.imageSourceTexts ?? []).join('\n'), /late developer text|late system text/);
  }));

test('Chat planner treats every system/developer shape as an opaque history barrier', async () => {
  for (const role of ['system', 'developer']) {
    for (const content of ['', 'authority', [{ type: 'text', text: 'authority' }],
      [{ type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }]]) {
      const item = { role, content, metadata: { keep: true } };
      const [turn] = history.chatMessagesToTurns([item], { collapseImages: true, dropTools: true });
      assert.equal(turn.opaque, true, `${role} ${JSON.stringify(content)}`);
    }
  }
  const messages = [
    { role: 'user', content: historyText(0) },
    { role: 'assistant', content: 'tool call', tool_calls: [
      { id: 'call1', type: 'function', function: { name: 'shell', arguments: '{}' } },
    ] },
    { role: 'developer', content: 'authority between call and output' },
    { role: 'tool', tool_call_id: 'call1', content: 'output' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: historyText(i + 1) })),
  ];
  const plan = await history.planGptCollapse(
    history.chatMessagesToTurns(messages, { collapseImages: true, dropTools: true }), 0, () => true,
    { keepTail: 2, keepRecentPairs: 0, minCollapsePrefix: 1, minCollapseTokens: 0,
      collapseChunk: 1, freezeChunk: 0, maxImages: 80 });
  assert.ok(plan.images.length > 0, 'tool-closed earlier history can still collapse');
  assert.ok(plan.endExclusive <= 1, 'never collapse the call without its output across authority');
});

test('Chat history-only collapse preserves edited, removed, and empty late authority', () =>
  withEnv(historyEnv, async () => {
    const before = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: historyText(i),
    }));
    const after = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user', content: historyText(i + 25),
    }));
    for (const role of ['developer', 'system']) {
      for (const content of ['original authority', 'edited authority', '']) {
        const authority = { role, content, name: `${role}_barrier`, metadata: { revision: content } };
        const messages = [...before, authority, ...after];
        const r = await core.transformOpenAIChatCompletions(encode({ model: 'gpt-6.2-sol', messages }),
          { ...opts, collapseHistory: true, gptHistory: { sectionTokens: 700 } });
        assert.equal(r.info.historyReason, 'collapsed');
        const wire = decoded(r).messages;
        const pos = wire.findIndex(item => item.name === authority.name);
        assert.ok(pos >= 0);
        assert.deepEqual(wire.slice(pos), [authority, ...after]);
      }
    }
    const messages = [...before, ...after];
    const r = await core.transformOpenAIChatCompletions(encode({ model: 'gpt-6.2-sol', messages }),
      { ...opts, collapseHistory: true, gptHistory: { sectionTokens: 700 } });
    assert.equal(r.info.historyReason, 'collapsed');
    assert.ok(!decoded(r).messages.some(item => item.name?.endsWith('_barrier')));
  }));

for (const api of ['responses', 'chat']) {
  test(`${api}: mixed opening authority survives enabled history collapse with metadata intact`, () =>
    withEnv(historyEnv, async () => {
      const responses = api === 'responses';
      const authority = { role: 'developer', name: 'opening', metadata: { revision: 9 },
        content: [{ type: responses ? 'input_text' : 'text', text: staticText, annotations: [{ note: 'keep' }] },
          responses ? { type: 'input_image', image_url: 'https://example.invalid/opening.png', detail: 'high' }
            : { type: 'image_url', image_url: { url: 'https://example.invalid/opening.png', detail: 'high' } }] };
      const items = [authority, ...Array.from({ length: 45 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user', content: historyText(i),
      }))];
      const key = responses ? 'input' : 'messages';
      const transform = responses ? core.transformOpenAIResponses : core.transformOpenAIChatCompletions;
      const r = await transform(encode({ model: 'gpt-6.2-sol', [key]: items }),
        { ...opts, collapseHistory: true, gptHistory: { sectionTokens: 700, responsesMode: 'mixed' } });
      assert.equal(r.info.historyReason, 'collapsed');
      const wire = decoded(r)[key];
      assert.ok(wire.length < items.length, 'history actually collapsed');
      assert.deepEqual(wire[0], authority);
      assert.deepEqual(wire.slice(-4), items.slice(-4));
      assert.ok(!wire.some(slabMarker), 'unsafe opening content is not imaged');
    }));
}
