// No sliding image window: adding a request must not evict old pixels or restore
// pixels already folded into a history checkpoint. No live server/API.
import assert from 'node:assert/strict';
import test from 'node:test';
import { GATE_ENV_OFF, withEnv } from './lib-test-env.mjs';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest, readNoteText } = await import(core + 'transform.js');
const { transformOpenAIResponses, transformOpenAIChatCompletions } = await import(core + 'openai.js');
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => JSON.parse(new TextDecoder().decode(b));
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const env = { ...GATE_ENV_OFF, PXLITE_READ_NOTE: undefined };
const cases = [
  {
    kind: 'Claude', transform: transformRequest, key: 'messages',
    body: { model: 'claude-sonnet-5-5', max_tokens: 20 },
    image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    textType: 'text',
  },
  {
    kind: 'GPT Responses', transform: transformOpenAIResponses, key: 'input',
    body: { model: 'gpt-6.2-sol' },
    image: { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
    textType: 'input_text',
  },
  {
    kind: 'GPT Chat', transform: transformOpenAIChatCompletions, key: 'messages',
    body: { model: 'gpt-6.2-sol' },
    image: { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
    textType: 'text',
  },
];

for (const c of cases) {
  test(`${c.kind}: 20 images survive; a new request changes neither old images nor old text`, () => withEnv(env, async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      role: 'user', content: [{ type: c.textType, text: `image ${i}` }, structuredClone(c.image)],
    }));
    const body = { ...c.body, [c.key]: items };
    const original = JSON.stringify(body);
    const first = dec((await c.transform(enc(body))).body);
    assert.equal(JSON.stringify(body), original, 'client history was not modified');
    const countImages = (r) => r[c.key].flatMap((m) => m.content).filter((b) => b.type === c.image.type).length;
    assert.equal(countImages(first), 20, 'no 15-image cap');
    assert.ok(!JSON.stringify(first).includes('[image omitted:'));
    assert.deepEqual(first[c.key].slice(0, -1), items.slice(0, -1));
    assert.equal(readNoteText(), '');
    assert.deepEqual(first[c.key].at(-1), items.at(-1), 'no reminder appended to the live tail');

    // Build the next request from the client's history, NOT the rewritten wire body.
    body[c.key].push({ role: 'assistant', content: [{ type: c.textType === 'input_text' ? 'output_text' : 'text', text: 'description of the images' }] });
    body[c.key].push({ role: 'user', content: [{ type: c.textType, text: 'continue' }] });
    const next = dec((await c.transform(enc(body))).body);
    assert.equal(countImages(next), 20);
    assert.deepEqual(next[c.key].slice(0, 20), items.slice(0, 20), 'the previous tail reminder is not persisted');
    assert.deepEqual(next[c.key].at(-1), body[c.key].at(-1));
    assert.ok(!JSON.stringify(next).includes('Before answering, read every image'));
  }));
}

test('Claude checkpoint: old Read pixels are not resurrected; recent Read pixels remain native', () => withEnv({
  ...env, PXLITE_MIN_SHRINK_TOKENS: 0, PXLITE_MIN_COLLAPSE_MESSAGES: 0,
}, async () => {
  const text = (i) => Array.from({ length: 12 }, (_, j) =>
    `Turn ${i} line ${j}: the build log shows step ${i * 7 + j} finished; compare cache reads against writes for request ${i}.`).join('\n');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'checkpoint-read-pixels inspect this UI' }] }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'text', text: text(i) },
      { type: 'tool_use', id: `read-${i}`, name: 'Read', input: { file_path: `/tmp/screenshot-${i}.png` } },
    ] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: [
      { type: 'text', text: `Read screenshot ${i}: ${text(i + 100)}` }, structuredClone(image),
    ] }] });
  }
  const r = await transformRequest(enc({ model: 'claude-opus-5-5', max_tokens: 20,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: 'text', text: Array.from({ length: 300 }, (_, i) => text(i)).join('\n') }],
    messages,
  }), { model: 'claude-opus-5-5' });
  assert.equal(r.info.historyReason, 'collapsed');
  const out = dec(r.body);
  const native = (node) => {
    if (!node || typeof node !== 'object') return 0;
    if (node.type === 'image' && node.source?.data === PNG) return 1;
    return Object.values(node).reduce((n, v) => n + native(v), 0);
  };
  const remaining = native(out);
  assert.ok(remaining > 0 && remaining < 30, `checkpoint drops old pixels, keeps live tail: ${remaining}`);
  assert.equal(r.info.nativeImagesRestored, undefined);
  assert.ok(out.messages.some((m) => m.content?.some?.((b) => b.type === 'tool_result' && b.tool_use_id === 'read-29')),
    'latest Read remains in the tool chain');
}));
