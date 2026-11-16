#!/usr/bin/env node
// pxclaude: start pxlite hidden if it is not listening, then run Claude Code behind it.
// Arguments go to claude unchanged. Works on Windows, macOS and Linux.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PXLITE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pxlite.mjs');
const WIN = process.platform === 'win32';

function status() {
  const r = spawnSync(process.execPath, [PXLITE, 'status'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

let st = status();
if (!st) {
  spawn(process.execPath, ['--max-old-space-size=512', PXLITE, 'serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20 && !st; i++) {
    await new Promise((r) => setTimeout(r, 500));
    st = status();
  }
  if (!st) {
    console.error('pxclaude: pxlite did not start; run "pxlite serve" to see the error');
    process.exit(1);
  }
}

function findOnPath(name) {
  const exts = WIN ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    }
  }
  return null;
}

const claude = findOnPath('claude');
if (!claude) {
  console.error('pxclaude: "claude" is not on PATH');
  process.exit(1);
}

const env = { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${st.connect_port}`, NODE_EXTRA_CA_CERTS: st.ca_bundle };
const args = process.argv.slice(2);

let child;
if (WIN && /\.(cmd|bat)$/i.test(claude)) {
  // Node will not spawn a .cmd without a shell, and a shell would split quoted arguments.
  const q = (a) => `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[q(claude), ...args.map(q)].join(' ')}"`], { stdio: 'inherit', env, windowsVerbatimArguments: true });
} else {
  child = spawn(claude, args, { stdio: 'inherit', env });
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on('error', (err) => { console.error(`pxclaude: ${err.message}`); process.exit(1); });
