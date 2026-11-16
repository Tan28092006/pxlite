// Size-capped JSONL log: at most `maxBytes` live plus one `.1` backup, and
// files untouched for `maxAgeDays` are deleted at startup and on rotation.
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;

export class RotatingLog {
  constructor(file, { maxBytes = 5 * 1024 * 1024, maxAgeDays = 14, now = () => Date.now() } = {}) {
    this.file = file;
    this.backup = file.replace(/(\.jsonl)?$/, '.1.jsonl');
    this.maxBytes = maxBytes;
    this.maxAgeMs = maxAgeDays * DAY_MS;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.prune();
    this.size = sizeOf(file);
    if (this.size >= this.maxBytes) this.rotate();
  }

  prune() {
    for (const f of [this.file, this.backup]) {
      try {
        if (this.now() - fs.statSync(f).mtimeMs > this.maxAgeMs) fs.unlinkSync(f);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }

  rotate() {
    if (sizeOf(this.file) > 0) fs.renameSync(this.file, this.backup);
    this.size = 0;
    this.prune();
  }

  write(record) {
    const line = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    this.size += bytes;
  }
}

function sizeOf(f) {
  try {
    return fs.statSync(f).size;
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }
}
