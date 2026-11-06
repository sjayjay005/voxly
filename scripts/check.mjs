// Fast sanity checks used by CI: every script parses and the manifest points at files that exist.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
for (const f of walk('src').filter((f) => f.endsWith('.js'))) execFileSync('node', ['--check', f]);
const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
for (const f of [m.background.service_worker, ...Object.values(m.icons)]) if (!existsSync(f)) throw new Error('missing ' + f);
console.log('✓ checks passed');
