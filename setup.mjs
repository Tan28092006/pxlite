// pxlite setup: opt-in wiring of clients to the pxlite proxy, each step reversible with --undo.
//   claude-vscode  VS Code user settings: claudeCode.environmentVariables (HTTPS_PROXY, NODE_EXTRA_CA_CERTS)
//   codex          ~/.codex/config.toml: openai_base_url
//   opencode       Desktop shortcut "OpenCode (pxlite)" (Windows)
//   autostart      Startup shortcut that runs pxlite hidden at logon (Windows)
// Nothing is changed without a yes (or --yes). The first copy of a file is kept as <file>.bak-pxlite-<date>.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const TARGETS = ['claude-vscode', 'codex', 'opencode', 'autostart'];
const SHORTCUT_OPENCODE = 'OpenCode (pxlite).lnk';
const SHORTCUT_STARTUP = 'pxlite.lnk';

const USAGE = `usage: pxlite setup [target] [--undo] [--yes] [--file PATH]
targets:
  claude-vscode   Claude Code in VS Code (also Cursor etc. with --file <their settings.json>)
  codex           Codex app and CLI (~/.codex/config.toml)
  opencode        Desktop shortcut "OpenCode (pxlite)"            (Windows)
  autostart       start pxlite hidden at logon                     (Windows)
no target: show which are on.  Run "pxlite serve" (or pxclaude) once first so the CA file exists.`;

export async function setupCmd(args, ctx) {
  const flags = { undo: false, yes: false, file: null };
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--undo') flags.undo = true;
    else if (args[i] === '--yes' || args[i] === '-y') flags.yes = true;
    else if (args[i] === '--file') flags.file = args[++i];
    else rest.push(args[i]);
  }
  const env = {
    ...ctx,
    proxyUrl: `http://127.0.0.1:${ctx.connectPort}`,
    codexUrl: `http://127.0.0.1:${ctx.port}/backend-api/codex`,
    caBundle: path.join(ctx.stateDir, 'warp-ca-bundle.pem'),
  };
  const target = rest[0];
  if (!target) return showStatus(env);
  if (target === 'help' || target === '--help' || !TARGETS.includes(target)) {
    console.error(USAGE);
    process.exit(target === 'help' || target === '--help' ? 0 : 64);
  }
  const fn = { 'claude-vscode': claudeVscode, codex, opencode, autostart }[target];
  await fn(env, flags);
}

// ---------- shared helpers ----------

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('Not an interactive terminal: re-run with --yes to apply.');
    process.exitCode = 1;
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === 'y' || answer === 'yes';
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.bak-pxlite-${stamp()}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function needWindows(what) {
  if (WIN) return true;
  console.error(`pxlite setup ${what} is Windows-only.`);
  return false;
}

function ps(script, extraEnv) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'powershell failed').trim());
  return r.stdout.trim();
}

function writeVbs(file, text) {
  // wscript reads ANSI unless the file is UTF-16 with a BOM; user names may hold non-ASCII letters.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf16le')]));
}

function template(name, vars) {
  let text = fs.readFileSync(path.join(HERE, 'templates', name), 'utf8');
  for (const [k, v] of Object.entries(vars)) text = text.split(`@@${k}@@`).join(v);
  return text;
}

function makeShortcut(lnk, target, args, icon) {
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  ps('$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:PXL_LNK);$s.TargetPath=$env:PXL_TARGET;$s.Arguments=$env:PXL_ARGS;$s.WindowStyle=7;if($env:PXL_ICON){$s.IconLocation=$env:PXL_ICON};$s.Save()',
    { PXL_LNK: lnk, PXL_TARGET: target, PXL_ARGS: args, PXL_ICON: icon ?? '' });
}

function startupDir() {
  return process.env.PXLITE_STARTUP_DIR ?? path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
function desktopDir() {
  return process.env.PXLITE_DESKTOP_DIR ?? ps('[Environment]::GetFolderPath("Desktop")');
}

function warnNoCa(env) {
  if (!fs.existsSync(env.caBundle)) console.log(`Note: ${env.caBundle} does not exist yet. Run "pxlite serve" (or pxclaude) once so pxlite creates it.`);
}

// ---------- claude-vscode ----------

function vscodeSettingsPath(flags) {
  if (flags.file) return path.resolve(flags.file);
  if (WIN) return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'settings.json');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
  return path.join(os.homedir(), '.config', 'Code', 'User', 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { json: {}, indent: 4, existed: false };
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const indent = (text.match(/^([ \t]+)"/m) ?? [])[1] ?? 4;
  if (!text.trim()) return { json: {}, indent, existed: true };
  try { return { json: JSON.parse(text), indent, existed: true }; } catch { return null; }
}

async function claudeVscode(env, flags) {
  const file = vscodeSettingsPath(flags);
  const wanted = [{ name: 'HTTPS_PROXY', value: env.proxyUrl }, { name: 'NODE_EXTRA_CA_CERTS', value: env.caBundle }];
  const snippet = `"claudeCode.environmentVariables": ${JSON.stringify(wanted, null, 4)}`;
  const st = readSettings(file);
  if (!st) {
    console.error(`${file} has comments or trailing commas, so pxlite will not rewrite it.\nAdd this to it by hand${flags.undo ? ' (or remove it)' : ''}:\n\n${snippet}`);
    process.exit(2);
  }
  const key = 'claudeCode.environmentVariables';
  const current = Array.isArray(st.json[key]) ? st.json[key] : [];
  const ours = (e) => e && ((e.name === 'HTTPS_PROXY' && e.value === env.proxyUrl) || (e.name === 'NODE_EXTRA_CA_CERTS' && e.value === env.caBundle));
  if (flags.undo) {
    const kept = current.filter((e) => !ours(e));
    if (kept.length === current.length) { console.log('claude-vscode: nothing of pxlite in', file); return; }
    if (!(await confirm(`Remove the pxlite proxy variables from ${file}?`, flags))) return;
    if (kept.length) st.json[key] = kept; else delete st.json[key];
  } else {
    if (!(await confirm(`Set HTTPS_PROXY=${env.proxyUrl} and NODE_EXTRA_CA_CERTS=${env.caBundle} for Claude Code in ${file}?`, flags))) return;
    st.json[key] = [...current.filter((e) => !(e && (e.name === 'HTTPS_PROXY' || e.name === 'NODE_EXTRA_CA_CERTS'))), ...wanted];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backup(file);
  fs.writeFileSync(file, JSON.stringify(st.json, null, st.indent) + '\n');
  console.log(`claude-vscode: ${flags.undo ? 'removed from' : 'written to'} ${file}${bak ? ` (backup ${bak})` : ''}`);
  if (!flags.undo) { warnNoCa(env); console.log('Takes effect for new Claude sessions in VS Code (reload the window).'); }
}

// ---------- codex ----------

function codexConfigPath(flags) {
  return flags.file ? path.resolve(flags.file) : path.join(os.homedir(), '.codex', 'config.toml');
}

async function codex(env, flags) {
  const file = codexConfigPath(flags);
  const line = `openai_base_url = "${env.codexUrl}"`;
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  let top = lines.findIndex((l) => /^\s*\[/.test(l));
  if (top < 0) top = lines.length;
  const at = lines.slice(0, top).findIndex((l) => /^\s*openai_base_url\s*=/.test(l));
  if (flags.undo) {
    if (at < 0 || !lines[at].includes(env.codexUrl)) { console.log('codex: no pxlite openai_base_url in', file); return; }
    if (!(await confirm(`Remove ${line} from ${file}?`, flags))) return;
    const drop = at > 0 && /^#\s*pxlite\b/.test(lines[at - 1]) ? 2 : 1;
    lines.splice(drop === 2 ? at - 1 : at, drop);
  } else {
    if (at >= 0 && lines[at].trim() === line) { console.log('codex: already set in', file); return; }
    if (!(await confirm(`Set ${line} in ${file}? (Codex then sends its requests through pxlite; delete the line to go direct.)`, flags))) return;
    if (at >= 0) lines[at] = line;
    else lines.unshift('# pxlite: route Codex through the local proxy', line);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bak = backup(file);
  fs.writeFileSync(file, lines.join(eol));
  console.log(`codex: ${flags.undo ? 'removed from' : 'written to'} ${file}${bak ? ` (backup ${bak})` : ''}`);
  if (!flags.undo) warnNoCa(env);
}

// ---------- autostart / opencode (Windows) ----------

function startVbsPath(env) { return path.join(env.stateDir, 'start-hidden.vbs'); }

function writeStartVbs(env) {
  writeVbs(startVbsPath(env), template('start-hidden.vbs', { PXLITE_MJS: env.pxliteMjs }));
}

async function autostart(env, flags) {
  if (!needWindows('autostart')) return;
  const lnk = path.join(startupDir(), SHORTCUT_STARTUP);
  if (flags.undo) {
    if (!fs.existsSync(lnk)) { console.log('autostart: no pxlite shortcut in', startupDir()); return; }
    if (!(await confirm(`Remove ${lnk}?`, flags))) return;
    fs.rmSync(lnk);
    console.log('autostart: removed', lnk);
    return;
  }
  if (!(await confirm(`Create ${lnk} so pxlite starts hidden at logon?`, flags))) return;
  writeStartVbs(env);
  makeShortcut(lnk, 'wscript.exe', `"${startVbsPath(env)}"`);
  console.log('autostart: created', lnk);
}

async function opencode(env, flags) {
  if (!needWindows('opencode')) return;
  const lnk = path.join(desktopDir(), SHORTCUT_OPENCODE);
  if (flags.undo) {
    if (!fs.existsSync(lnk)) { console.log('opencode: no shortcut at', lnk); return; }
    if (!(await confirm(`Remove ${lnk}?`, flags))) return;
    fs.rmSync(lnk);
    console.log('opencode: removed', lnk);
    return;
  }
  const exe = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ai.opencode.desktop', 'OpenCode.exe');
  if (!fs.existsSync(exe)) {
    console.error(`opencode: ${exe} not found; install OpenCode desktop first.`);
    process.exit(1);
  }
  if (!(await confirm(`Create the desktop shortcut ${lnk}? It starts pxlite, then OpenCode with the proxy variables set for that app only.`, flags))) return;
  writeStartVbs(env);
  const launcher = path.join(env.stateDir, 'opencode-pxlite.vbs');
  writeVbs(launcher, template('opencode-pxlite.vbs', { START_VBS: startVbsPath(env), PROXY_URL: env.proxyUrl, CA_BUNDLE: env.caBundle }));
  makeShortcut(lnk, 'wscript.exe', `"${launcher}"`, `${exe},0`);
  console.log('opencode: created', lnk, '(quit OpenCode fully, then open this shortcut)');
  warnNoCa(env);
}

// ---------- status ----------

function showStatus(env) {
  const flags = {};
  const rows = [];
  try {
    const st = readSettings(vscodeSettingsPath(flags));
    const arr = st?.json?.['claudeCode.environmentVariables'];
    rows.push(['claude-vscode', st ? (Array.isArray(arr) && arr.some((e) => e?.name === 'HTTPS_PROXY' && e.value === env.proxyUrl) ? 'on' : 'off') : 'settings.json has comments (edit by hand)']);
  } catch { rows.push(['claude-vscode', '?']); }
  const cfg = codexConfigPath(flags);
  rows.push(['codex', fs.existsSync(cfg) && fs.readFileSync(cfg, 'utf8').includes(env.codexUrl) ? 'on' : 'off']);
  if (WIN) {
    try { rows.push(['opencode', fs.existsSync(path.join(desktopDir(), SHORTCUT_OPENCODE)) ? 'on' : 'off']); } catch { rows.push(['opencode', '?']); }
    rows.push(['autostart', fs.existsSync(path.join(startupDir(), SHORTCUT_STARTUP)) ? 'on' : 'off']);
  }
  for (const [name, state] of rows) console.log(`${name.padEnd(14)} ${state}`);
  console.log(`\n${USAGE}`);
}
