// Fast sanity checks used by CI: every script parses and the manifest points at files that exist.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk('src').filter((f) => f.endsWith('.js'))) execFileSync('node', ['--check', f]);
const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
const referenced = [m.background.service_worker, ...Object.values(m.icons)];
if (m.side_panel?.default_path) referenced.push(m.side_panel.default_path);
for (const f of referenced) if (!existsSync(f)) throw new Error('missing ' + f);

// The committed worker bundle must not reach for a CDN. build.mjs asserts this too, but this
// check needs no node_modules, so it also catches a bad bundle that was committed by hand.
const worker = readFileSync('src/offscreen/kokoro-worker.js', 'utf8');
if (worker.includes('cdn.jsdelivr.net')) throw new Error('src/offscreen/kokoro-worker.js references a CDN; run npm run build');

// Both version fields are read by the Chrome Web Store; disagreeing is always a mistake.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version !== m.version) throw new Error(`version mismatch: package.json ${pkg.version} vs manifest.json ${m.version}`);

console.log('✓ checks passed');
