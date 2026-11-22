import assert from 'node:assert/strict';
import test from 'node:test';
import { describeGptUpstream, describeGptResponse } from './gpt-upstream-diagnostics.mjs';
test('outgoing diagnostics identify routing/key drift without retaining prompts or IDs from input', () => {
  const body = { model: 'gpt-6.1-sol', prompt_cache_key: 'PRIVATE-SESSION',
    previous_response_id: 'PRIVATE-PREVIOUS', tools: [{ description: 'SECRET TOOL' }],
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'SECRET PROMPT', prompt_cache_breakpoint: { mode: 'explicit' } },
      { type: 'input_image', image_url: 'SECRET PIXELS' },
    ] }] };
  const run = (b, url = 'https://api.openai.com/v1/responses') =>
    describeGptUpstream(url, JSON.stringify(b));
  const a = run(body);
  assert.equal(a.anchors, 1);
  assert.equal(a.images, 1);
  assert.equal(a.has_previous_response, true);
  assert.equal(a.cache_mode, 'default');
  assert.ok(!JSON.stringify(a).includes('SECRET'));
  assert.ok(!JSON.stringify(a).includes('PRIVATE'));
  assert.equal(run({ ...body, input: [] }).cache_key_sha, a.cache_key_sha);
  assert.notEqual(run({ ...body, prompt_cache_key: 'other' }).cache_key_sha, a.cache_key_sha);
  assert.notEqual(run(body, 'https://chatgpt.com/backend-api/codex/responses').endpoint_sha, a.endpoint_sha);
});
test('response correlation never consumes or clones a stream and validates header IDs', () => {
  const response = new Response('untouched', { headers: { 'x-request-id': 'req_123', 'x-response-id': 'resp_456' } });
  const d = describeGptResponse(response);
  assert.equal(d.request_id, 'req_123');
  assert.equal(d.response_id, 'resp_456');
  assert.equal(response.bodyUsed, false);
  assert.equal(describeGptResponse(new Response('', { headers: { 'x-request-id': 'private data with spaces' } })).request_id, null);
});
