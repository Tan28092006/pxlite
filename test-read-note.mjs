// Reminder retirement is permanent, including legacy environment overrides.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withEnv } from './lib-test-env.mjs';
import { appendReadNote, readNoteText, transformRequest } from './vendor/pxpipe-proxy/dist/core/transform.js';
import { transformOpenAIChatCompletions, transformOpenAIResponses } from './vendor/pxpipe-proxy/dist/core/openai.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const enc = x => new TextEncoder().encode(JSON.stringify(x));
for (const setting of [undefined, '0', 'off', 'Custom legacy reminder']) {
  test(`no live reminder for any wire, env=${String(setting)}`, () => withEnv({ PXLITE_READ_NOTE: setting }, async () => {
    assert.equal(readNoteText(setting), '');
    for (const kind of ['messages', 'chat', 'responses']) {
      const input = { body: enc({ input: [{ role: 'user', content: [{ type: 'input_image', image_url: png,
        cache_control: { type: 'ephemeral' } }] }] }), info: {} };
      assert.equal(appendReadNote(input, kind), input);
      assert.deepEqual(input.info, {});
    }
    const content = [{ type: 'input_text', text: 'ORIGINAL' }, { type: 'input_image', image_url: png }];
    const cases = [
      [transformOpenAIResponses, { model: 'gpt-6.1-sol', input: [{ role: 'user', content }] }],
      [transformOpenAIChatCompletions, { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: [
        { type: 'text', text: 'ORIGINAL' }, { type: 'image_url', image_url: { url: png } },
      ] }] }],
      [transformRequest, { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [
        { type: 'text', text: 'ORIGINAL' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.split(',')[1] } },
      ] }] }],
    ];
    for (const [run, body] of cases) {
      const bytes = enc(body);
      const out = await run(bytes, { compress: false });
      assert.deepEqual(out.body, bytes);
      assert.ok(!out.info?.readNote);
    }
  }));
}
