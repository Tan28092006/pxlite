// Render a text file the way pxpipe's history collapse would for one model.
// usage: node render.mjs <pxpipe-package-dir> <model> <text-file> <out-prefix> [vi-mode]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [pkg, model, file, outPrefix, fontOverride] = process.argv.slice(2);
const { renderTextToImages } = await import(pathToFileURL(path.join(pkg, 'dist', 'core', 'library.js')).href);
const text = fs.readFileSync(file, 'utf8');
// Optional: render with Sol's 14px JetBrains Mono geometry instead of the model's own.
const extra = fontOverride === 'jb14'
  ? { cols: 84, maxHeightPx: 1954, style: { font: 'jetbrains-mono-14', cellWBonus: 0, cellHBonus: 0, aa: true } }
  : {};
const { pages } = await renderTextToImages(text, { model, reflow: true, ...extra });
pages.forEach((p, i) => fs.writeFileSync(`${outPrefix}-p${i + 1}.png`, p.png));
const px = pages.reduce((s, p) => s + p.width * p.height, 0);
console.log(JSON.stringify({ model, pages: pages.length, dims: pages.map((p) => `${p.width}x${p.height}`), chars: text.length, claude_image_tokens: Math.round(px / 750) }));
