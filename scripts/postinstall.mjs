// Build vendor/pxpipe-proxy: a copy of the pinned upstream package with pxlite's seven
// changed files laid over it (Vietnamese glyph atlases, byte-budget trim, tool-call drop,
// compaction summary kept whole; see patches/README.md).
// Idempotent. Refuses to touch a file whose bytes are not the ones the overlay was made for.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'pxpipe-proxy');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'overlay', 'manifest.json'), 'utf8'));

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fail = (msg) => { console.error(`[pxlite] postinstall: ${msg}`); process.exit(1); };

function findUpstream() {
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const cand = path.join(dir, 'node_modules', 'pxpipe-proxy');
    if (fs.existsSync(path.join(cand, 'package.json'))) return cand;
    if (path.dirname(dir) === dir) return null;
  }
}

const upstream = findUpstream();
if (!upstream) {
  // npm also runs this script in a scratch clone of a git dependency, before any dependency is
  // installed there. Skip quietly then; the real install, or the first run, builds vendor/.
  if (path.basename(process.argv[1] ?? '') === 'postinstall.mjs') {
    console.log('[pxlite] postinstall: pxpipe-proxy not installed in this directory yet; vendor/ will be built later');
    process.exit(0);
  }
  fail('pxpipe-proxy is not installed (npm should have fetched it as a dependency)');
}
const version = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'), 'utf8')).version;
if (version !== manifest.upstreamVersion) {
  fail(`found pxpipe-proxy ${version}, the overlay is for ${manifest.upstreamVersion}`);
}

fs.rmSync(VENDOR, { recursive: true, force: true });
fs.mkdirSync(path.dirname(VENDOR), { recursive: true });
fs.cpSync(upstream, VENDOR, { recursive: true });

let applied = 0;
for (const f of manifest.files) {
  const target = path.join(VENDOR, f.path);
  const have = sha(fs.readFileSync(target));
  if (have !== f.upstreamSha256) fail(`${f.path} differs from upstream ${manifest.upstreamVersion} (sha256 ${have}); not overwriting`);
  const over = fs.readFileSync(path.join(ROOT, 'overlay', f.path));
  if (sha(over) !== f.overlaySha256) fail(`overlay/${f.path} is corrupted (line endings changed by git? see .gitattributes)`);
  fs.writeFileSync(target, over);
  applied++;
}
console.log(`[pxlite] vendor/pxpipe-proxy ${version} ready, ${applied} files overlaid`);
