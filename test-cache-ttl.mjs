// node --test test-cache-ttl.mjs - needs vendor/ built with overlay. No API calls.
// Markers without ttl (OpenCode) become 1h; explicit client choices are never mixed.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest } = await import(core + 'transform.js');

async function run(body) {
  const { body: out } = await transformRequest(new TextEncoder().encode(JSON.stringify(body)), { model: 'claude-opus-5-5' });
  return JSON.parse(new TextDecoder().decode(out));
}
const ttls = (req) => [
  ...(req.system ?? []),
  ...req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
].filter((b) => b.cache_control).map((b) => b.cache_control.ttl);

const mk = (cc) => ({
  model: 'claude-opus-5-5',
  max_tokens: 10,
  system: [{ type: 'text', text: 'sys', cache_control: cc() }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: cc() }] }],
});

test('markers without ttl get 1h', async () => {
  assert.deepEqual(ttls(await run(mk(() => ({ type: 'ephemeral' })))), ['1h', '1h']);
});

test('explicit 5m is left alone', async () => {
  assert.deepEqual(ttls(await run(mk(() => ({ type: 'ephemeral', ttl: '5m' })))), ['5m', '5m']);
});

test('PXLITE_CACHE_TTL=5m disables the rewrite', async () => {
  process.env.PXLITE_CACHE_TTL = '5m';
  try {
    assert.deepEqual(ttls(await run(mk(() => ({ type: 'ephemeral' })))), [undefined, undefined]);
  } finally {
    delete process.env.PXLITE_CACHE_TTL;
  }
});
