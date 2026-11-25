// node --test test-history-junk.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const core = pathToFileURL(path.join(ROOT, 'vendor/pxpipe-proxy/dist/core/')).href;
const { collapseJunkLines } = await import(core + 'history.js');

test('a long run of numbered-empty lines becomes one marker with its range', () => {
  const lines = ['head'];
  for (let n = 158247; n <= 160222; n++) lines.push(`${n}:`);
  lines.push('tail');
  const out = collapseJunkLines(lines.join('\n'));
  assert.equal(out, 'head\n[... 1976 empty numbered lines omitted (158247..160222) ...]\ntail');
});

test('numbered lines that still carry content are untouched', () => {
  const text = ['10: const a = 1;', '11: const b = 2;', '12:', '13:', '14: x'].join('\n');
  assert.equal(collapseJunkLines(text), text);
});

test('short runs below the threshold are kept as is', () => {
  const text = 'a\n1:\n2:\n3:\nb';
  assert.equal(collapseJunkLines(text), text);
});

test('identical consecutive lines collapse, Vietnamese text is preserved byte for byte', () => {
  const rep = Array(7).fill('Đang chạy lại bài kiểm tra').join('\n');
  const out = collapseJunkLines(`Xin chào tiếng Việt\n${rep}\nxong`);
  assert.equal(out, 'Xin chào tiếng Việt\nĐang chạy lại bài kiểm tra\n[... previous line repeated 6 more times ...]\nxong');
});

test('output is a pure function of the input', () => {
  const text = Array.from({ length: 50 }, (_, i) => `${i}:`).join('\n');
  assert.equal(collapseJunkLines(text), collapseJunkLines(text));
});
