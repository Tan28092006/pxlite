// pxlite recall-test: end-to-end proof that "recall" loads an earlier session as images.
// A random password is written into a source session, that session's transcript is pinned
// (so the source can even be deleted), and a second run must answer the password. The
// answer can only come from the compressed images: the test session never sees the source.
//
//   pxlite recall-test [--client opencode|claude|all] [--model <id>]... [--all] [--wait]
//
// --wait blocks until the running proxy is newer than pxlite.mjs (after a restart).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir, RECALL_MARK } from './recall-sessions.mjs';

const PORT = Number(process.env.PXLITE_PORT ?? 47821);
const PROXY = process.env.HTTPS_PROXY || `http://127.0.0.1:${Number(PORT) + 1}`;

export const OPENCODE_CLI =
  process.env.PXLITE_OPENCODE_CLI ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ai.opencode.desktop', 'resources', 'opencode-cli.exe')
    : 'opencode');

const password = () => `VAULT-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
/** Compare ignoring ANSI colour codes, whitespace and punctuation, which CLIs insert inside a word. */
const clean = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[^A-Za-z0-9]/g, '');
const hasPassword = (out, secret) => clean(out).includes(clean(secret));
const nonce = () => crypto.randomBytes(3).toString('hex');

async function status() {
  const res = await fetch(`http://127.0.0.1:${PORT}/pxlite/status`);
  if (!res.ok) throw new Error(`status HTTP ${res.status}`);
  return res.json();
}

/** Run a command with stdin closed (opencode-cli waits for EOF on a pipe), capturing all output. */
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(file, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HTTPS_PROXY: process.env.HTTPS_PROXY || PROXY,
        HTTP_PROXY: process.env.HTTP_PROXY || PROXY,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || path.join(os.homedir(), '.pxpipe', 'warp-ca-bundle.pem'),
      },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => p.kill(), opts.timeout ?? 300_000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ out, code }); });
    p.on('error', (err) => { clearTimeout(timer); resolve({ out: '', code: -1, missing: err.code === 'ENOENT' }); });
  });
}

const ocApi = async (route) => JSON.parse((await run(OPENCODE_CLI, ['api', 'get', route], { timeout: 20_000 })).out);

async function ocSessionByTitle(title, dir) {
  const params = new URLSearchParams({ limit: '50', order: 'desc', parentID: 'null', directory: dir });
  const r = await ocApi(`/api/session?${params}`);
  return r.data?.find((s) => s.title === title) ?? null;
}

async function deleteOcSession(id) {
  if (id) await run(OPENCODE_CLI, ['session', 'delete', id], { timeout: 30_000 });
}

/** Remove pins that hold this test's password, so a random secret never persists. */
function scrubPins(secret) {
  for (const dir of [path.join(os.homedir(), '.pxpipe', 'recall-pins-any'), path.join(os.homedir(), '.pxpipe', 'opencode-session-pins')]) {
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of names) {
      const f = path.join(dir, n);
      try {
        if (fs.readFileSync(f, 'utf8').includes(secret)) fs.unlinkSync(f);
      } catch {}
    }
  }
}

const PROMPT = 'Rules: do not use any tool. When a message starts with "recall", answer with the vault password found in the attached context, nothing else. Reply OK now.';

async function opencodeCase(model) {
  const n = nonce();
  const pw = password();
  const dir = process.cwd();
  const ocModel = model.includes('/') ? model : `openai/${model}`;
  const sourceTitle = `Vault ${n}`;
  const testTitle = `Recall test ${n}`;
  let source = null;
  let session = null;
  try {
    // The password is stored by a model outside pxlite's scope; only the pin and images carry it.
    const made = await run(OPENCODE_CLI, ['run', '--model', 'opencode/deepseek-v4.1-flash-free', '--title', sourceTitle, `Tra loi dung mot cau, khong them gi: mat khau ket sat cua du an la ${pw}.`], { cwd: dir });
    if (made.missing) return { skip: 'opencode-cli not found' };
    source = await ocSessionByTitle(sourceTitle, dir);
    if (!source) return { fail: 'source session was not created' };
    // Two turns: the rules live in the test session, the recall command arrives as a follow-up.
    // --standalone keeps the request on this process's proxy env, so the test works from any
    // directory, not only from projects the desktop service already knows.
    await run(OPENCODE_CLI, ['run', '--standalone', '--model', ocModel, '--title', testTitle, PROMPT], { cwd: dir });
    session = await ocSessionByTitle(testTitle, dir);
    if (!session) return { fail: 'test session was not created' };
    const before = (await status()).openCodeSessionRecall;
    const t = await run(OPENCODE_CLI, ['run', '--standalone', '--session', session.id, '--model', ocModel, `recall vault ${n}`], { cwd: dir });
    const after = (await status()).openCodeSessionRecall;
    const pass = hasPassword(t.out, pw);
    return { pass, images: Math.max(0, after.injected - before.injected), note: pass ? 'password read from images' : `no password in ${t.out.trim().split('\n').slice(-1)[0]?.slice(0, 90) ?? 'output'}` };
  } finally {
    await deleteOcSession(session?.id);
    await deleteOcSession(source?.id);
    scrubPins(pw);
  }
}

function claudeTranscript(pw, n, dir) {
  const folder = claudeProjectDir(dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${crypto.randomUUID()}.jsonl`);
  const now = Date.now();
  const line = (o) => JSON.stringify({ sessionId: path.basename(file, '.jsonl'), cwd: dir, timestamp: new Date(now + o.i * 1000).toISOString(), ...o });
  const user = (i, text) => line({ i, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = (i, text) => line({ i, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const rows = [
    line({ i: 0, type: 'ai-title', aiTitle: `Vault ${n}` }),
    user(1, `Ghi nho mat khau ket sat cua du an: ${pw}. Chi tra loi OK.`),
    assistant(2, 'OK.'),
    user(3, `Mat khau ket sat la gi? ${'Khong can giai thich. '.repeat(300)}`),
    assistant(4, `Mat khau ket sat cua du an la ${pw}.`),
    user(5, 'Cam on. Giu nguyen gia tri do cho phien sau.'),
  ];
  fs.writeFileSync(file, `${rows.join('\n')}\n`, { mode: 0o600 });
  return file;
}

async function claudeCase(model) {
  const isWin = process.platform === 'win32';
  const wrapper = path.join(process.env.USERPROFILE ?? os.homedir(), '.local', 'bin', isWin ? 'pxclaude.cmd' : 'pxclaude');
  const hasWrapper = fs.existsSync(wrapper);
  if (!hasWrapper) {
    const which = await run(isWin ? 'where.exe' : 'which', ['claude'], { timeout: 10_000 });
    if (which.missing || which.code !== 0) return { skip: 'claude CLI not on PATH' };
  }
  const n = nonce();
  const pw = password();
  const dir = process.cwd();
  const sid = crypto.randomUUID();
  const testFile = path.join(claudeProjectDir(dir), `${sid}.jsonl`);
  let source;
  try {
    source = claudeTranscript(pw, n, dir);
    const call = (args) => (hasWrapper ? run(isWin ? 'cmd.exe' : wrapper, isWin ? ['/d', '/c', wrapper, ...args] : args, { cwd: dir, timeout: 600_000 }) : run('claude', args, { cwd: dir, timeout: 600_000 }));
    // Two turns: the rules live in the test session, the recall command arrives as a follow-up.
    await call(['-p', '--session-id', sid, '--model', model, PROMPT]);
    const before = (await status()).sessionRecall;
    const r = await call(['-p', '--resume', sid, '--model', model, `recall vault ${n}`]);
    const after = (await status()).sessionRecall;
    if (/hit your (?:session|usage|weekly) limit|usage limit reached|not logged in/i.test(r.out)) return { skip: r.out.trim().split('\n').find((l) => /limit|logged in/i.test(l))?.slice(0, 90) ?? 'Claude Code unavailable' };
    const pass = hasPassword(r.out, pw);
    return { pass, images: Math.max(0, after.injected - before.injected), note: pass ? 'password read from images' : `no password in ${r.out.trim().split('\n').slice(-1)[0]?.slice(0, 90) ?? 'output'}` };
  } finally {
    for (const f of [source, testFile]) {
      if (!f) continue;
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    scrubPins(pw);
  }
}

/** True when the running proxy predates the recall code (it is still executing the previous code). */
export async function staleProxy() {
  try {
    const st = await status();
    const started = Date.parse(st.started);
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
    const files = fs.readdirSync(here).filter((n) => n === 'pxlite.mjs' || (n.startsWith('recall') && n.endsWith('.mjs') && n !== 'recall-test.mjs'));
    const mtime = Math.max(...files.map((n) => fs.statSync(path.join(here, n)).mtimeMs));
    return Number.isFinite(started) && started < mtime;
  } catch {
    return true;
  }
}

export async function recallTest(args) {
  const clients = [];
  const models = [];
  let wait = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--client') clients.push(...String(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--model') models.push(args[++i]);
    else if (a === '--all') clients.push('all');
    else if (a === '--wait') wait = true;
    else {
      console.error('usage: pxlite recall-test [--client opencode|claude|all] [--model <id>]... [--all] [--wait]');
      process.exit(64);
    }
  }
  if (clients.includes('all') || !clients.length) clients.splice(0, clients.length, 'opencode', 'claude');
  for (const c of clients) if (!['opencode', 'claude'].includes(c)) {
    console.error(`pxlite: unknown client ${c}`);
    process.exit(64);
  }

  const pick = (client) => (models.length ? models : client === 'opencode' ? ['gpt-6.1-sol', 'gpt-6.1-terra', 'opencode/deepseek-v4.1-flash-free'] : ['claude-sonnet-5-5']);

  if (wait) {
    for (let i = 0; i < 240 && (await staleProxy()); i++) {
      if (i % 6 === 0) console.log('waiting for the proxy to restart with the current pxlite.mjs ...');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (await staleProxy()) {
    console.warn('pxlite: the running proxy started before pxlite.mjs was last modified;');
    console.warn('pxlite: restart it (start-hidden.vbs) or the new recall code is not exercising.');
  }

  const rows = [];
  for (const client of clients) {
    for (const model of pick(client)) {
      let r;
      try {
        r = client === 'opencode' ? await opencodeCase(model) : await claudeCase(model);
      } catch (err) {
        r = { fail: err.message };
      }
      rows.push({ client, model, ...r });
    }
  }

  const width = Math.max(6, ...rows.map((r) => r.model.length));
  console.log(`${'client'.padEnd(9)} ${'model'.padEnd(width)}  result  images  note`);
  for (const r of rows) {
    const result = r.skip ? 'SKIP' : r.pass ? 'PASS' : 'FAIL';
    console.log(`${r.client.padEnd(9)} ${r.model.padEnd(width)}  ${result.padEnd(6)}  ${String(r.images ?? 0).padStart(6)}  ${r.skip ?? r.fail ?? r.note ?? ''}`);
  }
  if (rows.some((r) => !r.pass && !r.skip)) process.exitCode = 1;
  if (rows.every((r) => r.skip)) console.log('nothing ran; install the missing client and retry.');
  console.log(`recall mark used by the proxy: ${RECALL_MARK} …]`);
}
