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
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString('utf8') });
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
  };
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
  return { base, install, seen, status };
}

const chatBody = JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hello opencode' }] });
const headers = { 'content-type': 'application/json', authorization: 'Bearer test' };

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
