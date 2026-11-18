// node --test test-serve.mjs
// Runs the real `pxlite serve` from a folder whose name has spaces and non-ASCII letters, with a
// local server standing in for opencode.ai, and checks what that server receives.
// Needs vendor/ (built by `npm install`); skipped otherwise.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(HERE, 'vendor', 'pxpipe-proxy');
const SKIP = fs.existsSync(path.join(VENDOR, 'package.json')) ? false : 'vendor/ not built (run npm install)';

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServe(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxlite-serve-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  // Install dir: spaces and Vietnamese letters, the case a file-URL pathname breaks on.
  const install = path.join(tmp, 'pxlite ĐIỂM PHÚ');
  fs.mkdirSync(install);
  for (const f of fs.readdirSync(HERE)) {
    if (/\.mjs$/.test(f) && !/^test/.test(f)) fs.copyFileSync(path.join(HERE, f), path.join(install, f));
  }
  fs.copyFileSync(path.join(HERE, 'config.default.json'), path.join(install, 'config.default.json'));
  fs.symlinkSync(path.join(HERE, 'vendor'), path.join(install, 'vendor'), 'junction');

  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body });
      if (req.url.startsWith('/v1/messages')) return void answerMessages(res, JSON.parse(body).stream === true);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
      );
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = upstream.address().port;

  const port = await freePort();
  const connectPort = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PORT: String(port),
    PXLITE_CONNECT_PORT: String(connectPort),
    PXPIPE_MODELS: 'off',
    PXLITE_OPENCODE_UPSTREAM: `http://127.0.0.1:${upstreamPort}/inference/openai`,
    PXLITE_ANTHROPIC_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  };
  delete env.PXPIPE_LOG;
  delete env.PXLITE_PKG;
  const child = spawn(process.execPath, [path.join(install, 'pxlite.mjs'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  t.after(async () => {
    child.kill();
    upstream.close();
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let status = null;
  for (let i = 0; i < 100 && status === null; i++) {
    if (child.exitCode !== null) assert.fail(`pxlite serve exited ${child.exitCode}:\n${log}`);
    try {
      status = await (await fetch(`${base}/pxlite/status`)).json();
    } catch {
      await sleep(200);
    }
  }
  assert.ok(status, `pxlite serve did not come up:\n${log}`);
  return { base, install, seen, status, home };
}

/** Minimal Anthropic Messages reply, as one JSON body or as an SSE stream. */
function answerMessages(res, stream) {
  const usage = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!stream) {
    res.setHeader('content-type', 'application/json');
    return void res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage }));
  }
  res.setHeader('content-type', 'text/event-stream');
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: 'm', content: [], usage } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}

const readEvents = (home) => {
  const file = path.join(home, '.pxpipe', 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const chatBody = JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hello opencode' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer test' };

// Rules under test (pxlite.mjs claudeRequestTags):
// - session_id: header x-claude-code-session-id, else metadata.user_id JSON .session_id; absent otherwise.
// - agent_role: subagent if x-claude-code-agent-id is sent, main if only the session header is, else unknown.
// - body_kind: delta iff no tools and system (billing line excluded) is under 2000 chars; else full.
test('events.jsonl tags Claude requests with session_id, agent_role, body_kind and no prompt text', { skip: SKIP }, async (t) => {
  const { base, home } = await startServe(t);
  const SECRET = 'PROMPT-TEXT-MUST-NOT-BE-LOGGED';
  const billing = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.310; cc_entrypoint=cli;' };
  const sysText = (n) => ({ type: 'text', text: SECRET + 'x'.repeat(n - SECRET.length) });
  const tool = { name: 'Read', description: SECRET, input_schema: { type: 'object' } };
  const S1 = '7d644ddd-6d7b-483a-8706-99101d1874aa';
  const S2 = '11111111-2222-3333-4444-555555555555';
  const rows = [
    { name: 'main turn: session header, long system, tools, streamed', hdr: { 'x-claude-code-session-id': S1 }, body: { system: [billing, sysText(5000)], tools: [tool], stream: true }, want: { session_id: S1, agent_role: 'main', body_kind: 'full' } },
    { name: 'subagent delta: agent id header, no system, no tools, streamed', hdr: { 'x-claude-code-session-id': S1, 'x-claude-code-agent-id': 'a5362aa3c04d9a24d' }, body: { stream: true }, want: { session_id: S1, agent_role: 'subagent', body_kind: 'delta' } },
    { name: 'session only in metadata.user_id, no headers', hdr: {}, body: { metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: S2 }) }, system: 'short', tools: [] }, want: { session_id: S2, agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'billing line alone does not count, however long', hdr: {}, body: { system: [{ type: 'text', text: billing.text + 'b'.repeat(3000) }] }, want: { agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'system 1999 chars is still delta', hdr: {}, body: { system: [billing, sysText(1999)] }, want: { agent_role: 'unknown', body_kind: 'delta' } },
    { name: 'system 2000 chars is full', hdr: {}, body: { system: [billing, sysText(2000)] }, want: { agent_role: 'unknown', body_kind: 'full' } },
    { name: 'tools alone make it full', hdr: {}, body: { tools: [tool] }, want: { agent_role: 'unknown', body_kind: 'full' } },
    { name: 'metadata.user_id that is not JSON gives no session_id', hdr: {}, body: { metadata: { user_id: 'user_abc' } }, want: { agent_role: 'unknown', body_kind: 'delta' } },
  ];
  for (const [i, row] of rows.entries()) {
    const body = { model: 'claude-test', max_tokens: 8, messages: [{ role: 'user', content: SECRET }], ...row.body };
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { ...headers, 'x-api-key': 'k', 'anthropic-version': '2023-06-01', ...row.hdr }, body: JSON.stringify(body) });
    assert.equal(res.status, 200, row.name);
    await res.text();
    let evs = [];
    for (let k = 0; k < 50 && evs.length <= i; k++) {
      evs = readEvents(home).filter((e) => e.path === '/v1/messages');
      if (evs.length <= i) await sleep(100);
    }
    const ev = evs[i];
    assert.ok(ev, `${row.name}: no event logged`);
    const got = { agent_role: ev.agent_role, body_kind: ev.body_kind };
    if ('session_id' in ev) got.session_id = ev.session_id;
    assert.deepEqual(got, row.want, row.name);
  }
  const raw = fs.readFileSync(path.join(home, '.pxpipe', 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(SECRET), 'prompt text leaked into events.jsonl');
});

test('serve resolves vendor/ from a path with spaces and non-ASCII letters', { skip: SKIP }, async (t) => {
  const { install, status } = await startServe(t);
  assert.equal(path.normalize(status.pkg), path.join(install, 'vendor', 'pxpipe-proxy'));
  assert.doesNotMatch(status.pkg, /%[0-9A-Fa-f]{2}/);
});

test('OpenCode Chat Completions path is rewritten and sent to the OpenCode upstream', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t);
  const res = await fetch(`${base}/inference/openai/v1/chat/completions`, { method: 'POST', headers, body: chatBody });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].url, '/inference/openai/v1/chat/completions');
  assert.match(seen[0].body, /hello opencode/);
});

test('OpenCode Responses path goes to the OpenCode upstream too', { skip: SKIP }, async (t) => {
  const { base, seen } = await startServe(t);
  const body = JSON.stringify({ model: 'deepseek-v4.1-flash-free', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello responses' }] }] });
  const res = await fetch(`${base}/inference/openai/v1/responses`, { method: 'POST', headers, body });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, '/inference/openai/v1/responses');
  assert.match(seen[0].body, /hello responses/);
});

test('config.default.json: every GPT-wire model renders Spleen 5x8 with 2px rows', async () => {
  if (SKIP) return;
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'config.default.json'), 'utf8'));
  const before = process.env.PXPIPE_GPT_PROFILES;
  process.env.PXPIPE_GPT_PROFILES = JSON.stringify(cfg.gptProfiles);
  try {
    const { resolveGptProfile } = await import(pathToFileURL(path.join(VENDOR, 'dist', 'core', 'gpt-model-profiles.js')).href);
    for (const model of ['gpt-6.1-sol', 'gpt-6.1-sol-fast', 'gpt-6.1-terra', 'deepseek-v4.1-flash-free', 'opencode/deepseek-v4.1-flash-free']) {
      const { style } = resolveGptProfile(model);
      assert.equal(style.font, 'spleen-5x8', model);
      assert.equal(style.cellHBonus, 2, model);
    }
  } finally {
    if (before === undefined) delete process.env.PXPIPE_GPT_PROFILES;
    else process.env.PXPIPE_GPT_PROFILES = before;
  }
});
