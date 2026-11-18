// node --test test-history-cache-marker.mjs — needs vendor/ (junction to ~/.pxpipe-lite/vendor).
// Cache-cost T3: the last history image carries its own cache_control marker.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PXPIPE_MODELS ??= 'claude-opus-5-5';
const core = new URL('./vendor/pxpipe-proxy/dist/core/', import.meta.url).href;
const { transformRequest, markLastHistoryImage, MAX_CACHE_BREAKPOINTS } = await import(core + 'transform.js');
const { HISTORY_SYNTHETIC_INTRO } = await import(core + 'history.js');

const H1 = { type: 'ephemeral', ttl: '1h' };
const line = (i, j) => `Turn ${i} line ${j}: the build log shows step ${i * 7 + j} finished; next we compare cache reads against writes for request ${i}.`;
const text = (i, n) => Array.from({ length: n }, (_, j) => line(i, j)).join('\n');

/** Claude-Code-shaped body: identity + static system block (marked), `turns` closed turns, marked final user turn. */
function claudeBody(turns, { tailMarks = [] } = {}) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: text(i, 12) }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: text(i + 1000, 12) }] });
  }
  for (const k of tailMarks) messages[messages.length + k].content[0].cache_control = { ...H1 };
  messages.push({ role: 'user', content: [{ type: 'text', text: 'current question', cache_control: { ...H1 } }] });
  return {
    model: 'claude-opus-5-5',
    max_tokens: 100,
    system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }, { type: 'text', text: text(9999, 300), cache_control: { ...H1 } }],
    messages,
  };
}

async function transform(body) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const { body: out, info } = await transformRequest(bytes, { model: 'claude-opus-5-5' });
  return { bytes, out, info, req: JSON.parse(new TextDecoder().decode(out)) };
}

/** Marked blocks in wire order as `m<msg>.b<block>` / `system.<i>` / `tools.<i>`. */
function markers(req) {
  const ids = [];
  (req.tools ?? []).forEach((t, i) => t.cache_control && ids.push(`tools.${i}`));
  (Array.isArray(req.system) ? req.system : []).forEach((b, i) => b.cache_control && ids.push(`system.${i}`));
  req.messages.forEach((m, mi) => (Array.isArray(m.content) ? m.content : []).forEach((b, bi) => {
    if (b.type === 'tool_result' && Array.isArray(b.content)) b.content.forEach((x, xi) => x.cache_control && ids.push(`m${mi}.b${bi}.${xi}`));
    if (b.cache_control) ids.push(`m${mi}.b${bi}`);
  }));
  return ids;
}

function historyImages(req) {
  const mi = req.messages.findIndex((m) => Array.isArray(m.content) && m.content[0]?.text === HISTORY_SYNTHETIC_INTRO);
  assert.ok(mi >= 0, 'request has a history message');
  return { mi, ids: req.messages[mi].content.map((b, bi) => (b.type === 'image' ? bi : -1)).filter((bi) => bi >= 0) };
}

test('AC4(a) compressed body: last history image carries a marker, total <= 4, final marker kept', async () => {
  // 20 turns → first collapse with no frozen carry-over chunk: the shape of the 2026-11-18 06:32 rewrites.
  const { req, info } = await transform(claudeBody(20));
  assert.equal(info.historyReason, 'collapsed');
  const { mi, ids } = historyImages(req);
  const lastImg = req.messages[mi].content[ids.at(-1)];
  assert.deepEqual(lastImg.cache_control, H1, 'TTL copied from the next marker');
  const marks = markers(req);
  assert.ok(marks.length <= MAX_CACHE_BREAKPOINTS, marks.join(' '));
  const lastMsg = req.messages.length - 1;
  assert.equal(marks.at(-1), `m${lastMsg}.b0`, 'client final marker stays last');
  assert.ok(marks.includes(`m${mi}.b${ids.at(-1)}`));
  // The gap the new marker bridges: far more than the ~20-block server lookback.
  const blocksAfter = req.messages[mi].content.length - 1 - ids.at(-1) + req.messages.slice(mi + 1).reduce((s, m) => s + m.content.length, 0);
  assert.ok(blocksAfter > 20, `history→final gap ${blocksAfter} blocks`);
});

test('AC4(a) compressed body with a frozen carry-over chunk: both the carry-over and the last image are marked', async () => {
  const { req, info } = await transform(claudeBody(60));
  assert.equal(info.historyReason, 'collapsed');
  const { mi, ids } = historyImages(req);
  const marked = ids.filter((bi) => req.messages[mi].content[bi].cache_control);
  assert.ok(marked.length === 2 && marked.at(-1) === ids.at(-1), `marked history images ${marked} of ${ids}`);
  assert.ok(markers(req).length <= MAX_CACHE_BREAKPOINTS);
});

test('AC4(a) system too short to image (collapse-only path): last history image still marked', async () => {
  const body = claudeBody(20);
  body.system = [{ type: 'text', text: 'short system', cache_control: { ...H1 } }];
  const { req, info } = await transform(body);
  assert.equal(info.historyReason, 'collapsed');
  assert.match(info.reason ?? '', /below_min_chars/, 'took the path where the slab does not image');
  const { mi, ids } = historyImages(req);
  assert.deepEqual(req.messages[mi].content[ids.at(-1)].cache_control, H1, 'TTL from the final user marker');
  assert.deepEqual(markers(req), ['system.0', `m${mi}.b${ids.at(-1)}`, `m${req.messages.length - 1}.b0`]);
});

test('AC4(b) client already uses 4 markers: still 4, final kept, the tail marker nearest the final is dropped', async () => {
  // system (→ slab anchor) + two tail markers + final = 4 before the new one.
  const { req, info } = await transform(claudeBody(20, { tailMarks: [-5, -3] }));
  assert.equal(info.historyReason, 'collapsed');
  const { mi, ids } = historyImages(req);
  const marks = markers(req);
  assert.equal(marks.length, MAX_CACHE_BREAKPOINTS, marks.join(' '));
  const last = req.messages.length - 1;
  assert.equal(marks.at(-1), `m${last}.b0`, 'final marker survives');
  assert.ok(marks.includes(`m${mi}.b${ids.at(-1)}`), 'history marker added');
  assert.ok(marks.includes(`m${last - 5}.b0`), 'earlier tail marker kept');
  assert.ok(!marks.includes(`m${last - 3}.b0`), 'tail marker nearest the final dropped');
});

test('AC4(c) uncompressed body passes through byte-identical', async () => {
  const body = { model: 'claude-opus-5-5', max_tokens: 10, system: [{ type: 'text', text: 'short', cache_control: { ...H1 } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { ...H1 } }] }] };
  const { bytes, out, info } = await transform(body);
  assert.notEqual(info.historyReason, 'collapsed');
  assert.deepEqual(Buffer.from(out), Buffer.from(bytes));
});

test('AC4(c) compressed body without history: no marker added, markers as the client sent them', async () => {
  const { req, info } = await transform(claudeBody(2));
  assert.notEqual(info.historyReason, 'collapsed');
  assert.ok(!req.messages.some((m) => Array.isArray(m.content) && m.content[0]?.text === HISTORY_SYNTHETIC_INTRO));
  const before = JSON.stringify(req);
  assert.equal(markLastHistoryImage(req), false);
  assert.equal(JSON.stringify(req), before);
  assert.equal(markers(req).length, 2, 'slab anchor + final, as before');
});

test('markLastHistoryImage: table of edge cases', () => {
  const img = (cc) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' }, ...(cc ? { cache_control: cc } : {}) });
  const hist = (...imgs) => ({ role: 'user', content: [{ type: 'text', text: HISTORY_SYNTHETIC_INTRO }, ...imgs, { type: 'text', text: 'after' }] });
  const tail = (cc) => ({ role: 'user', content: [{ type: 'text', text: 'q', ...(cc ? { cache_control: cc } : {}) }] });
  const cases = [
    { name: 'TTL absent on next marker → plain ephemeral', req: { messages: [hist(img()), tail({ type: 'ephemeral' })] }, changed: true, cc: { type: 'ephemeral' } },
    { name: 'scope on next marker is not copied', req: { messages: [hist(img()), tail({ type: 'ephemeral', ttl: '5m', scope: 'global' })] }, changed: true, cc: { type: 'ephemeral', ttl: '5m' } },
    { name: 'no client marker after history → untouched', req: { system: [{ type: 'text', text: 's', cache_control: H1 }], messages: [hist(img()), tail()] }, changed: false },
    { name: 'last image already marked → untouched', req: { messages: [hist(img(), img(H1)), tail(H1)] }, changed: false },
    { name: 'more than 4 markers already → untouched', req: { system: [1, 2, 3, 4].map(() => ({ type: 'text', text: 's', cache_control: H1 })), messages: [hist(img()), tail(H1)] }, changed: false },
    { name: 'no history message → untouched', req: { messages: [tail(H1)] }, changed: false },
  ];
  for (const c of cases) {
    const before = JSON.stringify(c.req);
    assert.equal(markLastHistoryImage(c.req), c.changed, c.name);
    if (!c.changed) assert.equal(JSON.stringify(c.req), before, c.name);
    else assert.deepEqual(c.req.messages[0].content.at(-2).cache_control, c.cc, c.name);
  }
});

test('markLastHistoryImage: at the cap, a marker before the history is dropped when the tail has none', () => {
  const img = (cc) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' }, ...(cc ? { cache_control: cc } : {}) });
  const sys = [0, 1, 2].map((i) => ({ type: 'text', text: `s${i}`, cache_control: { ...H1 } }));
  const req = { system: sys, messages: [{ role: 'user', content: [{ type: 'text', text: HISTORY_SYNTHETIC_INTRO }, img()] }, { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { ...H1 } }] }] };
  assert.equal(markLastHistoryImage(req), true);
  assert.deepEqual(markers(req), ['system.0', 'system.1', 'm0.b1', 'm1.b0']);
});
