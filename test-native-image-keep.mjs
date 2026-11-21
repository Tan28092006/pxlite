import { transformOpenAIChatCompletions, transformOpenAIResponses } from 'file:///C:/Users/acer/pxlite/vendor/pxpipe-proxy/dist/core/openai.js';
import { transformRequest } from 'file:///C:/Users/acer/pxlite/vendor/pxpipe-proxy/dist/core/transform.js';
import assert from 'node:assert/strict';
const enc = (o) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b) => new TextDecoder().decode(b);
const png = (i) => 'iVBORw0KGgo' + String(i).padStart(4, '0') + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const big = (i) => ('l' + i + ' abc def\n').repeat(6000);
const has = (s, i) => s.includes(png(i));

// Claude: 20 images spread over a long chat, forced collapse
{
  const messages = [];
  for (let i = 0; i < 60; i++) {
    const content = [{ type: 'text', text: big(i) }];
    if (i % 2 === 0) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(i) } });
    messages.push({ role: i % 2 ? 'assistant' : 'user', content: content });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'tiep' }] });
  const ids = messages.flatMap((m, i) => m.content.some((b) => b.type === 'image') ? [i] : []);
  const r = await transformRequest(enc({ model: 'claude-sonnet-5-5', max_tokens: 10, messages }), {});
  const out = dec(r.body);
  const kept = ids.filter((i) => has(out, i)), gone = ids.filter((i) => !has(out, i));
  console.log('Claude collapsed=', r.info.collapsedTurns, 'native images in:', ids.length, 'kept:', kept.length, 'dropped:', gone.length, 'restored:', r.info.nativeImagesRestored, 'droppedInfo:', r.info.nativeImagesDropped);
  assert.ok(kept.length <= 15);
  assert.deepEqual(kept, ids.slice(-kept.length), 'kept images must be the newest ones');
}
// GPT Responses: 20 images
{
  const input = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [{ type: 'input_text', text: 'm' + i }, { type: 'input_image', image_url: 'data:image/png;base64,' + png(i) }] }));
  input.push({ role: 'user', content: [{ type: 'input_text', text: 'tiep' }] });
  const r = await transformOpenAIResponses(enc({ model: 'gpt-6.2-sol', input }), {});
  const out = dec(r.body);
  const kept = [...Array(20).keys()].filter((i) => has(out, i));
  console.log('Responses kept:', kept.length, 'first kept:', kept[0], 'last:', kept.at(-1));
  assert.equal(kept.length, 15); assert.equal(kept[0], 5);
  assert.ok(out.includes('[image omitted'));
}
// GPT Chat Completions
{
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: 'm' + i }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png(i) } }] }));
  const r = await transformOpenAIChatCompletions(enc({ model: 'gpt-6.2-sol', messages }), {});
  const out = dec(r.body);
  const kept = [...Array(20).keys()].filter((i) => has(out, i));
  console.log('Chat kept:', kept.length, 'first kept:', kept[0]);
  assert.equal(kept.length, 15); assert.equal(kept[0], 5);
}
// Under the limit: untouched
{
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + png(1) }] }];
  const r = await transformOpenAIResponses(enc({ model: 'gpt-6.2-sol', input }), {});
  assert.ok(has(dec(r.body), 1));
}
console.log('ALL OK');

