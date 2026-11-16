// Maintainer tool: rebuild overlay/manifest.json from overlay/ and a pristine upstream install.
// usage: node scripts/make-overlay-manifest.mjs <dir containing a pristine pxpipe-proxy package>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pristine = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('usage: node scripts/make-overlay-manifest.mjs <pristine pxpipe-proxy dir>'); process.exit(2); }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name !== 'manifest.json') files.push(path.relative(path.join(ROOT, 'overlay'), full).split(path.sep).join('/'));
  }
})(path.join(ROOT, 'overlay'));

const version = JSON.parse(fs.readFileSync(path.join(pristine, 'package.json'), 'utf8')).version;
const out = {
  upstream: 'pxpipe-proxy',
  upstreamVersion: version,
  files: files.sort().map((p) => ({
    path: p,
    upstreamSha256: sha(path.join(pristine, p)),
    overlaySha256: sha(path.join(ROOT, 'overlay', p)),
  })),
};
fs.writeFileSync(path.join(ROOT, 'overlay', 'manifest.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`overlay/manifest.json: ${out.files.length} files for ${version}`);
