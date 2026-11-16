#!/usr/bin/env node
// `pxpipe stats` and the other upstream commands, from the overlaid vendored copy.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = new URL('./vendor/pxpipe-proxy/bin/cli.js', import.meta.url);
if (!fs.existsSync(fileURLToPath(cli))) await import('./scripts/postinstall.mjs');
await import(cli.href);
