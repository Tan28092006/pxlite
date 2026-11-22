// Pure outgoing-request diagnostics: no vendor import, API, timers, or services.
// Run: node --test test-gpt-prefix.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGptPrefixTracker } from './gpt-prefix.mjs';

const clone = value => structuredClone(value);
const context = { sessionKey: 'session-secret', route: '/v1/responses' };
const message = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const request = () => ({ model: 'gpt-test', instructions: 'private instructions', input: [message('private prompt')] });
const tracker = options => createGptPrefixTracker({ now: () => 100, ...options });
const change = (area, index, before_type, after_type, part = null) =>
  ({ area, index, before_type, after_type, part });

test('first, exact repeat, append, rewrite and truncate have a stable JSON-safe report', () => {
  const t = tracker();
  const b = request();
  assert.deepEqual(t.observe(b, context), {
    status: 'first', reason: null, has_key: true, common_items: 0,
    previous_items: null, current_items: 1, first_changed: null, truncated: false,
  });
  assert.deepEqual(t.observe(clone(b), context), {
    status: 'unchanged', reason: null, has_key: true, common_items: 1,
    previous_items: 1, current_items: 1, first_changed: null, truncated: false,
  });
  b.input.push(message('next'));
  let r = t.observe(b, context);
  assert.equal(r.status, 'append_only');
  assert.equal(r.common_items, 1);
  assert.equal(r.previous_items, 1);
  assert.equal(r.current_items, 2);
  assert.deepEqual(r.first_changed, change('input', 1, null, 'message'));
  b.input[1].content[0].text = 'different';
  r = t.observe(b, context);
  assert.equal(r.status, 'rewrite');
  assert.equal(r.common_items, 1);
  assert.deepEqual(r.first_changed, change('input', 1, 'message', 'message',
    change('content', 0, 'input_text', 'input_text')));
  b.input.pop();
  r = t.observe(b, context);
  assert.equal(r.status, 'truncate');
  assert.equal(r.common_items, 1);
  assert.deepEqual(r.first_changed, change('input', 1, 'message', null));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

for (const field of ['image_url', 'detail']) {
  test(`image ${field} change finds the native image part without exposing it`, () => {
    const t = tracker();
    const b = request();
    b.input[0].content.push({ type: 'input_image', image_url: 'data:image/png;base64,PIXELS-secret', detail: 'high' });
    t.observe(b, context);
    b.input[0].content[1][field] = field === 'detail' ? 'low' : 'data:image/png;base64,OTHER-secret';
    const r = t.observe(b, context);
    assert.equal(r.status, 'rewrite');
    assert.equal(r.common_items, 0);
    assert.deepEqual(r.first_changed, change('input', 0, 'message', 'message',
      change('content', 1, 'input_image', 'input_image')));
    assert.doesNotMatch(JSON.stringify(r), /PIXELS|OTHER|data:image|high|low/);
  });
}

test('reasoning encrypted_content is compared as an exact opaque native string, never normalized/decoded', () => {
  const t = tracker();
  const b = request();
  b.input.push({ type: 'reasoning', id: 'secret-id', summary: [], encrypted_content: 'YQ==' });
  t.observe(b, context);
  // Both spellings can decode to "a"; diagnostics must still see the native change.
  b.input[1].encrypted_content = 'YQ';
  const r = t.observe(b, context);
  assert.equal(r.status, 'rewrite');
  assert.equal(r.common_items, 1);
  assert.deepEqual(r.first_changed, change('input', 1, 'reasoning', 'reasoning'));
  b.input[1].encrypted_content = 'not even valid base64: private ciphertext!';
  assert.equal(t.observe(b, context).status, 'rewrite');
});

test('native tool arguments and old output are not skipped or interpreted', () => {
  const t = tracker();
  const b = request();
  b.input.push(
    { type: 'function_call', call_id: 'c', name: 'shell', arguments: '{"a":1}' },
    { type: 'function_call_output', call_id: 'c', output: 'old result' },
    message('latest'),
  );
  t.observe(b, context);
  b.input[1].arguments = '{ "a": 1 }';
  let r = t.observe(b, context);
  assert.equal(r.status, 'rewrite');
  assert.deepEqual(r.first_changed, change('input', 1, 'function_call', 'function_call'));
  b.input[2].output = 'new result';
  r = t.observe(b, context);
  assert.equal(r.common_items, 2);
  assert.deepEqual(r.first_changed, change('input', 2, 'function_call_output', 'function_call_output',
    change('output', 0, 'text', 'text')));
});

test('output arrays and inserted/deleted/type-changed parts identify the first differing part', () => {
  const t = tracker();
  const b = { input: [{ type: 'function_call_output', output: [
    { type: 'input_text', text: 'a' }, { type: 'input_image', image_url: 'private-url' },
  ] }] };
  t.observe(b, context);
  b.input[0].output[1] = { type: 'input_text', text: 'replacement' };
  assert.deepEqual(t.observe(b, context).first_changed.part,
    change('output', 1, 'input_image', 'input_text'));
  b.input[0].output.pop();
  assert.deepEqual(t.observe(b, context).first_changed.part, change('output', 1, 'input_text', null));
  b.input[0].output.push({ type: 'input_image', image_url: 'private-url' });
  assert.deepEqual(t.observe(b, context).first_changed.part, change('output', 1, null, 'input_image'));
});

test('Chat messages: image detail, tool arguments, tool output and scalar content', () => {
  const t = tracker();
  const c = { ...context, route: '/v1/chat/completions' };
  const b = { model: 'gpt-test', messages: [
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'secret', detail: 'high' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'f', arguments: '{"v":1}' } }] },
    { role: 'tool', tool_call_id: 'call', content: 'old' },
  ] };
  assert.equal(t.observe(b, c).status, 'first');
  b.messages[0].content[1].image_url.detail = 'low';
  assert.deepEqual(t.observe(b, c).first_changed,
    change('messages', 0, 'message', 'message', change('content', 1, 'image_url', 'image_url')));
  b.messages[1].tool_calls[0].function.arguments = '{"v":2}';
  assert.deepEqual(t.observe(b, c).first_changed, change('messages', 1, 'message', 'message'));
  b.messages[2].content = 'new';
  assert.deepEqual(t.observe(b, c).first_changed,
    change('messages', 2, 'message', 'message', change('content', 0, 'text', 'text')));
});

const topChanges = {
  instructions: ['a', 'b'],
  tools: [[{ type: 'function', name: 'f', parameters: { type: 'object' } }],
    [{ type: 'function', name: 'f', parameters: { type: 'object', required: ['private-name'] } }]],
  reasoning: [{ effort: 'low' }, { effort: 'high' }],
  text: [{ format: { type: 'text' } }, { format: { type: 'json_object' } }],
  response_format: [{ type: 'text' }, { type: 'json_object' }],
  tool_choice: ['auto', 'required'],
  parallel_tool_calls: [false, true],
  prompt_cache_key: ['key-secret-a', 'key-secret-b'],
  prompt_cache_options: [{ mode: 'auto' }, { mode: 'explicit' }],
  prompt_cache_retention: ['in_memory', '24h'],
  previous_response_id: ['private-response-a', 'private-response-b'],
  conversation: ['private-conversation-a', 'private-conversation-b'],
};
for (const [field, [before, after]] of Object.entries(topChanges)) {
  test(`top-level ${field} changes rewrite even with an appended item`, () => {
    const t = tracker();
    const b = request();
    b[field] = before;
    t.observe(b, context);
    b[field] = after;
    b.input.push(message('next'));
    const r = t.observe(b, context);
    assert.equal(r.status, 'rewrite');
    assert.equal(r.common_items, 1);
    assert.equal(r.first_changed.area, field);
    assert.equal(r.first_changed.index, null);
    assert.equal(r.first_changed.part, null);
  });
}

test('missing versus null fields and unrecognized options are conservative, with no raw field names', () => {
  const t = tracker();
  const b = request();
  t.observe(b, context);
  b.tools = null;
  assert.deepEqual(t.observe(b, context).first_changed, change('tools', null, null, 'null'));
  delete b.tools;
  assert.deepEqual(t.observe(b, context).first_changed, change('tools', null, 'null', null));
  b['private-new-option-name'] = { secret: 'value' };
  const r = t.observe(b, context);
  assert.equal(r.status, 'rewrite');
  assert.equal(r.first_changed.area, 'other');
  assert.doesNotMatch(JSON.stringify(r), /private-new-option-name|secret|value/);
});

test('only max-token/stream controls are ignored; no request mutation', () => {
  const t = tracker();
  const b = request();
  const original = clone(b);
  t.observe(b, context);
  assert.deepEqual(b, original);
  Object.assign(b, { max_tokens: 1, max_output_tokens: 2, max_completion_tokens: 3,
    stream: true, stream_options: { include_usage: true } });
  assert.equal(t.observe(b, context).status, 'unchanged');
  b.temperature = 0.2;
  assert.equal(t.observe(b, context).status, 'rewrite');
});

test('native object ordering, Unicode and field changes remain conservative; no argument JSON parsing', () => {
  const t = tracker();
  const b = { input: [{ type: 'function_call', arguments: 'not JSON: \ud800', name: 'f' }] };
  t.observe(b, context);
  b.input[0].arguments = 'not JSON: \ud801';
  assert.equal(t.observe(b, context).status, 'rewrite');
  b.input[0] = { name: 'f', arguments: 'not JSON: \ud801', type: 'function_call' };
  assert.equal(t.observe(b, context).status, 'rewrite');
});

test('unknown native type strings cannot leak; known labels are preserved', () => {
  const t = tracker();
  const b = { input: [{ type: 'SECRET-type', content: [{ type: 'SECRET-part', text: 'a' }] }] };
  t.observe(b, context);
  b.input[0].content[0].text = 'b';
  const r = t.observe(b, context);
  assert.deepEqual(r.first_changed, change('input', 0, 'unknown', 'unknown',
    change('content', 0, 'unknown', 'unknown')));
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
});

test('no key never creates or shares a session, including empty or invalid keys', () => {
  const t = tracker();
  for (const sessionKey of [undefined, null, '', '  ', 0, {}, []]) {
    for (let i = 0; i < 2; i++) assert.deepEqual(t.observe(request(), { sessionKey }), {
      status: 'unknown', reason: 'missing_session', has_key: false, common_items: null,
      previous_items: null, current_items: 1, first_changed: null, truncated: false,
    });
  }
  assert.equal(t.observe(request(), context).status, 'first');
  assert.equal(t.observe(request(), context).status, 'unchanged');
});

test('empty arrays are valid; missing/malformed bodies do not become empty prefixes', () => {
  const t = tracker();
  assert.equal(t.observe({ input: [] }, context).status, 'first');
  assert.equal(t.observe({ input: [] }, context).status, 'unchanged');
  assert.equal(t.observe({ input: [message('a')] }, context).status, 'append_only');
  assert.equal(t.observe({ input: [] }, context).status, 'truncate');
  for (const body of [undefined, null, '', 'not JSON', 1, [], {}, { input: 'scalar' },
    { input: null }, { messages: {} }, { input: [null] }, { input: [3] },
    { input: [], messages: [] }, { model: {}, input: [] }]) {
    const r = t.observe(body, context);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'invalid_body');
    assert.equal(r.first_changed, null);
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  }
});

test('non-JSON native values, cycles and getters fail closed without exposing error text', () => {
  const bad = [undefined, NaN, Infinity, 1n, () => 'secret', Symbol('secret')];
  const cycle = {}; cycle.self = cycle; bad.push(cycle);
  const getter = {};
  let getterCalls = 0;
  Object.defineProperty(getter, 'text', { enumerable: true, get() { getterCalls++; throw Error('secret'); } });
  bad.push(getter);
  for (const value of bad) {
    const t = tracker();
    const b = request();
    t.observe(b, context);
    b.input[0].extra = value;
    assert.equal(t.observe(b, context).status, 'unknown');
    // A failed snapshot invalidates this identifiable baseline.
    assert.equal(t.observe(request(), context).status, 'first');
  }
  assert.equal(getterCalls, 0);
});

test('malformed bodies invalidate their session/route scope instead of skipping an outgoing request', () => {
  for (const malformed of [null, {}, { model: 'gpt-test', input: 'bad' }, { input: [], messages: [] }]) {
    const t = tracker();
    const b = request();
    const otherSession = { ...context, sessionKey: 'other' };
    const otherRoute = { ...context, route: '/other' };
    for (const c of [context, otherSession, otherRoute]) t.observe(b, c);
    assert.equal(t.observe(malformed, context).status, 'unknown');
    assert.equal(t.observe(b, context).status, 'first');
    assert.equal(t.observe(b, otherSession).status, 'unchanged');
    assert.equal(t.observe(b, otherRoute).status, 'unchanged');
  }
});

test('default factory and missing context are safe; returned reports are detached', () => {
  const t = createGptPrefixTracker();
  const b = request();
  assert.equal(t.observe(b).reason, 'missing_session');
  assert.equal(t.observe(b, context).status, 'first');
  assert.equal(t.observe(b, context).status, 'unchanged');
  const frozen = Object.freeze({ model: 'frozen', input: Object.freeze([
    Object.freeze({ role: 'user', content: 'frozen text' }),
  ]) });
  assert.equal(t.observe(frozen, context).status, 'first');
  assert.equal(t.observe(frozen, context).status, 'unchanged');
});

test('session, model and exact route partition the state; missing route has a separate partition', () => {
  const t = tracker();
  const b = request();
  const partitions = [
    context, { ...context, sessionKey: 'other' }, { ...context, route: '/backend-api/codex/responses' },
    { sessionKey: context.sessionKey }, { ...context, route: '' },
  ];
  for (const c of partitions) assert.equal(t.observe(b, c).status, 'first');
  for (const c of partitions) assert.equal(t.observe(b, c).status, 'unchanged');
  assert.equal(t.observe({ ...b, model: 'different-model' }, context).status, 'first');
  assert.equal(t.observe(b, context).status, 'unchanged');
  const r = t.observe(b, { ...context, route: {} });
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'invalid_context');
});

test('input and messages are not interchangeable prefixes', () => {
  const t = tracker();
  const b = request();
  t.observe(b, context);
  const r = t.observe({ model: b.model, instructions: b.instructions, messages: b.input }, context);
  assert.equal(r.status, 'rewrite');
  assert.equal(r.first_changed.area, 'input_format');
  assert.equal(r.common_items, 0);
});

test('TTL expires at the boundary and refreshes on observation, not on an unrelated partition', () => {
  let clock = 0;
  const t = tracker({ now: () => clock, ttlMs: 10 });
  const b = request();
  assert.equal(t.observe(b, context).status, 'first');
  clock = 9;
  assert.equal(t.observe(b, context).status, 'unchanged');
  clock = 18;
  assert.equal(t.observe(b, { ...context, sessionKey: 'other' }).status, 'first');
  clock = 19;
  assert.equal(t.observe(b, context).status, 'first');
  clock = 1; // backwards clock cannot keep a stale baseline alive.
  assert.equal(t.observe(b, context).status, 'first');
});

test('LRU is bounded, access refreshes order, and model/route partitions consume separate slots', () => {
  const t = tracker({ maxSessions: 2 });
  const b = request();
  const a = context;
  const c = { ...context, route: '/other' };
  const d = { ...context, sessionKey: 'third' };
  assert.equal(t.observe(b, a).status, 'first');
  assert.equal(t.observe(b, c).status, 'first');
  assert.equal(t.observe(b, a).status, 'unchanged');
  assert.equal(t.observe(b, d).status, 'first');
  assert.equal(t.observe(b, a).status, 'unchanged');
  assert.equal(t.observe(b, c).status, 'first');
});

test('maxUnits bounds item plus part fingerprints; incomplete comparisons always report unknown', () => {
  const t = tracker({ maxUnits: 2 });
  const b = request(); // one item and one part: exactly fits.
  assert.equal(t.observe(b, context).status, 'first');
  assert.equal(t.observe(b, context).status, 'unchanged');
  b.input.push(message('b'));
  let r = t.observe(b, context);
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'limit');
  assert.equal(r.truncated, true);
  assert.equal(r.common_items, 1);
  b.input[1].content[0].text = 'invisible-to-retained-prefix';
  r = t.observe(b, context);
  assert.equal(r.status, 'unknown');
  assert.equal(r.common_items, 1);
  b.input.pop();
  assert.equal(t.observe(b, context).status, 'unknown', 'previous snapshot was incomplete');
  assert.equal(t.observe(b, context).status, 'unchanged', 'complete snapshots recover');
  const zero = tracker({ maxUnits: 0 });
  assert.equal(zero.observe({ input: [] }, context).status, 'first');
  assert.equal(zero.observe(b, context).status, 'unknown');
});

test('a single item with too many parts and deeply nested schemas cannot bypass limits', () => {
  const t = tracker({ maxUnits: 2 });
  const b = { input: [{ role: 'user', content: Array.from({ length: 20 }, () => ({ type: 'input_text', text: 'secret' })) }] };
  assert.equal(t.observe(b, context).status, 'unknown');
  assert.equal(t.observe(b, context).truncated, true);
  let deep = {};
  for (let i = 0; i < 200; i++) deep = { nested: deep };
  const r = tracker().observe({ input: [], tools: [deep] }, context);
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'limit');
});

test('disabled storage, invalid options and failing clocks are explicit', () => {
  for (const options of [{ maxSessions: 0 }, { ttlMs: 0 }]) {
    const t = tracker(options);
    assert.equal(t.observe(request(), context).reason, 'disabled');
    assert.equal(t.observe(request(), context).status, 'unknown');
  }
  for (const options of [{ maxUnits: -1 }, { maxUnits: 1.5 }, { maxSessions: NaN }, { ttlMs: Infinity }, { now: null }])
    assert.throws(() => tracker(options), TypeError);
  for (const now of [() => NaN, () => { throw Error('secret clock'); }]) {
    const r = tracker({ now }).observe(request(), context);
    assert.equal(r.reason, 'invalid_clock');
    assert.doesNotMatch(JSON.stringify(r), /secret/);
  }
});

test('reports expose neither payload, hashes, identifiers nor mutable internal state', () => {
  const t = tracker();
  const b = request();
  b.model = 'MODEL-SECRET';
  b.instructions = 'INSTRUCTIONS-SECRET';
  b.input[0].content.push({ type: 'input_image', image_url: 'https://secret/image?token=TOKEN-SECRET' });
  b.input.push({ type: 'reasoning', encrypted_content: 'CIPHERTEXT-SECRET', summary: [] });
  b['API-KEY-SECRET'] = 'CREDENTIAL-SECRET';
  const c = { sessionKey: 'SESSION-SECRET', route: 'https://USER:PASS@private/ROUTE-SECRET' };
  const first = t.observe(b, c);
  b.input[0].content[1].image_url += '-new';
  const changed = t.observe(b, c);
  assert.equal(changed.status, 'rewrite');
  assert.deepEqual(Object.keys(t), ['observe']);
  assert.deepEqual(Object.keys(changed).sort(), [
    'status', 'reason', 'has_key', 'common_items', 'previous_items', 'current_items', 'first_changed', 'truncated',
  ].sort());
  assert.doesNotMatch(JSON.stringify([t, first, changed]), /SECRET|private|https|TOKEN|CIPHERTEXT|[a-f0-9]{64}/);
  first.status = 'corrupt';
  changed.first_changed.part.before_type = 'corrupt';
  changed.current_items = 10000;
  assert.equal(t.observe(b, c).status, 'unchanged');
  b.input[0].content[1].image_url += '-again';
  assert.equal(t.observe(b, c).first_changed.part.before_type, 'input_image');
});
