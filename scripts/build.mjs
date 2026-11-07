// Rebuilds the files the extension vendors from npm, then optionally zips the extension for the Chrome Web Store.
//   npm run build   -> lib/Readability.js, src/offscreen/kokoro-worker.js, ort/
//   npm run zip     -> the above + dist/voxly-<version>.zip
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);
const nm = (p) => at('node_modules/' + p);

copyFileSync(nm('@mozilla/readability/Readability.js'), at('lib/Readability.js'));
copyFileSync(nm('@mozilla/readability/LICENSE.md'), at('lib/Readability-LICENSE.md'));

// pdf.js, for the PDF reader: the minified ES module build and its worker. No cmaps and no
// standard font data, because we extract text and never render a page.
copyFileSync(nm('pdfjs-dist/build/pdf.min.mjs'), at('lib/pdf.mjs'));
copyFileSync(nm('pdfjs-dist/build/pdf.worker.min.mjs'), at('lib/pdf.worker.mjs'));
copyFileSync(nm('pdfjs-dist/LICENSE'), at('lib/pdfjs-LICENSE'));

await build({
  entryPoints: [at('scripts/kokoro-worker.src.js')],
  outfile: at('src/offscreen/kokoro-worker.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', minify: true, logLevel: 'warning',
  alias: { 'fs/promises': at('scripts/empty.js'), fs: at('scripts/empty.js'), path: at('scripts/empty.js') },
  external: ['onnxruntime-node']
});
// No remote code: point transformers.js's CDN fallback for the WASM runtime at the copy we ship.
const wp = at('src/offscreen/kokoro-worker.js');
const worker = readFileSync(wp, 'utf8').replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}]+\}\/dist\//g, '${self.location.origin}/ort/');
if (worker.includes('cdn.jsdelivr.net')) throw new Error('kokoro-worker.js still references a CDN');
writeFileSync(wp, worker);

mkdirSync(at('ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'])
  copyFileSync(nm('@huggingface/transformers/dist/' + f), at('ort/' + f));
const ortWeb = existsSync(nm('onnxruntime-web/dist')) ? nm('onnxruntime-web/dist') : nm('@huggingface/transformers/node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copyFileSync(join(ortWeb, f), at('ort/' + f));
// Everything we vendor must be self-contained: the Chrome Web Store forbids loading code
// remotely, and our CSP would block it. pdf.js is the one here that could plausibly reach out.
for (const f of ['lib/pdf.mjs', 'lib/pdf.worker.mjs']) {
  const found = readFileSync(at(f), 'utf8').match(/https?:\/\/[^"'`\s]*(?:cdn|unpkg|jsdelivr)[^"'`\s]{0,60}/gi);
  if (found) throw new Error(`${f} references remote code: ${[...new Set(found)].slice(0, 3).join(', ')}`);
}

console.log('✓ vendored files rebuilt');

if (process.argv.includes('--zip')) {
  const { version } = JSON.parse(readFileSync(at('manifest.json'), 'utf8'));
  mkdirSync(at('dist'), { recursive: true });
  const zip = at(`dist/voxly-${version}.zip`);
  rmSync(zip, { force: true });
  execFileSync('zip', ['-qr9', zip, 'manifest.json', 'icons', 'lib', 'ort', 'src'], { cwd: root, stdio: 'inherit' });
  console.log('✓ ' + zip);
}
