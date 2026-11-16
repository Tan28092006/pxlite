// Transpile regenerated atlas .ts files into the vendored pxpipe dist/core.
import fs from 'node:fs';
import { transformSync } from 'esbuild';
const [outDir, coreDir] = process.argv.slice(2);
for (const name of ['atlas', 'atlas-gray', 'atlas-jbmono14', 'atlas-gray-jbmono14']) {
  const ts = fs.readFileSync(`${outDir}/${name}.ts`, 'utf8');
  const { code } = transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' });
  fs.writeFileSync(`${coreDir}/${name}.js`, code);
  console.log(`${name}.js`, code.length);
}
