// Rebuilds the files the extension vendors from npm, then optionally zips the extension for the Chrome Web Store.
//   npm run build   -> lib/Readability.js, src/offscreen/kokoro-worker.js, ort/
//   npm run zip     -> the above + dist/voxly-<version>.zip
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => join(root, p);
const nm = (p) => at('node_modules/' + p);

// Exactly one copy of transformers.js may exist. If a dependency pins a different major, npm
// nests a second copy and esbuild bundles both -- and the worker's `env` configuration then
// applies to whichever copy it imported, not the one kokoro-js loads the model through. The
// visible symptom is the ONNX runtime being fetched from a CDN at runtime, which our CSP blocks.
// Silent in the build, broken in the browser, so fail here instead.
function assertOneTransformers() {
  const root = nm('@huggingface/transformers');
  const copies = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name === '.bin') continue;
      const path = join(dir, name);
      if (name === '@huggingface' && existsSync(join(path, 'transformers/package.json'))) {
        copies.push(join(path, 'transformers'));
      }
      if (existsSync(join(path, 'node_modules'))) walk(join(path, 'node_modules'), depth + 1);
    }
  };
  walk(at('node_modules'), 0);
  const nested = copies.filter((p) => p !== root);
  if (!nested.length) return;
  const version = (p) => JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version;
  throw new Error(
    `Two copies of @huggingface/transformers are installed: ${version(root)} at the top level and `
    + nested.map((p) => `${version(p)} under ${p.replace(at('node_modules') + '/', '')}`).join(', ')
    + '. Bundling both breaks the runtime env configuration. Align the versions before building.'
  );
}
assertOneTransformers();

copyFileSync(nm('@mozilla/readability/Readability.js'), at('lib/Readability.js'));
copyFileSync(nm('@mozilla/readability/LICENSE.md'), at('lib/Readability-LICENSE.md'));

// pdf.js, for the PDF reader: the minified ES module build and its worker. No cmaps and no
// standard font data, because we extract text and never render a page.
copyFileSync(nm('pdfjs-dist/build/pdf.min.mjs'), at('lib/pdf.mjs'));
copyFileSync(nm('pdfjs-dist/build/pdf.worker.min.mjs'), at('lib/pdf.worker.mjs'));
copyFileSync(nm('pdfjs-dist/LICENSE'), at('lib/pdfjs-LICENSE'));

// fflate, to unzip EPUB containers. The browser ES module build; no worker, because our CSP
// allows no blob: scripts and fflate's async path builds its worker from one.
copyFileSync(nm('fflate/esm/browser.js'), at('lib/fflate.js'));
copyFileSync(nm('fflate/LICENSE'), at('lib/fflate-LICENSE'));

await build({
  entryPoints: [at('scripts/kokoro-worker.src.js')],
  outfile: at('src/offscreen/kokoro-worker.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', minify: true, logLevel: 'warning',
  alias: { 'fs/promises': at('scripts/empty.js'), fs: at('scripts/empty.js'), path: at('scripts/empty.js') },
  external: ['onnxruntime-node']
});
// No remote code: point every CDN fallback for the WASM runtime at the copy we ship. Both
// transformers.js and onnxruntime-web carry one, and which of them appears depends on the
// version, so match the shape rather than naming the package. The assertion below is the real
// guarantee -- it has already caught one new fallback that this rewrite did not know about.
const wp = at('src/offscreen/kokoro-worker.js');
const worker = readFileSync(wp, 'utf8')
  .replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/(?:@[\w.-]+\/)?[\w.-]+@\$\{[^}]+\}\/dist\//g, '${self.location.origin}/ort/');
if (worker.includes('cdn.jsdelivr.net')) {
  const stray = [...new Set(worker.match(/https:\/\/cdn\.jsdelivr\.net[^"'`\s]{0,80}/g) || [])];
  throw new Error('kokoro-worker.js still references a CDN:\n  ' + stray.join('\n  '));
}
writeFileSync(wp, worker);

mkdirSync(at('ort'), { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'])
  copyFileSync(nm('@huggingface/transformers/dist/' + f), at('ort/' + f));
const ortWeb = existsSync(nm('onnxruntime-web/dist')) ? nm('onnxruntime-web/dist') : nm('@huggingface/transformers/node_modules/onnxruntime-web/dist');
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copyFileSync(join(ortWeb, f), at('ort/' + f));
// Everything we vendor must be self-contained: the Chrome Web Store forbids loading code
// remotely, and our CSP would block it. pdf.js is the one here that could plausibly reach out.
for (const f of ['lib/pdf.mjs', 'lib/pdf.worker.mjs', 'lib/fflate.js']) {
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
