// What may go into the Chrome Web Store package.
//
// Version 3.0.0 was rejected for "having obfuscated code in the package", citing
// node_modules/pdfjs-dist/legacy/build/pdf.mjs — code Voxly neither ships nor uses. The package
// had been built by zipping the project folder instead of the extension. The first test here is
// that exact archive entry, so the failure cannot recur quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problemsIn, auditZip, PACKAGED, minificationProblem, unreadableScripts } from '../scripts/package-audit.mjs';

const EXTENSION = ['manifest.json', 'icons/icon16.png', 'lib/pdf.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'src/background/main.js'];

test('the extension itself is shippable', () => {
  assert.deepEqual(problemsIn(EXTENSION), []);
});

test('the exact file that got 3.0.0 rejected is refused', () => {
  const problems = problemsIn([...EXTENSION, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs']);
  assert.equal(problems.length, 2, 'both for being node_modules and for being outside the allowlist');
  assert.ok(problems.some((p) => p.includes('node_modules/pdfjs-dist/legacy/build/pdf.mjs')));
  assert.ok(problems.some((p) => p.includes('vendored copies')), 'should say where the real copy lives');
});

test('node_modules is refused wherever it appears', () => {
  for (const entry of ['node_modules/x.js', 'src/node_modules/x.js', 'node_modules']) {
    assert.ok(problemsIn([entry]).length, `${entry} should be refused`);
  }
});

test('build and test files are refused', () => {
  for (const entry of ['scripts/build.mjs', 'test/pacing.test.js', 'dist/voxly-3.0.0.zip', 'package.json', 'package-lock.json']) {
    assert.ok(problemsIn([entry]).length, `${entry} should be refused`);
  }
});

test('dotfiles and source maps are refused', () => {
  for (const entry of ['.DS_Store', '.github/workflows/ci.yml', 'src/.DS_Store', 'lib/pdf.mjs.map']) {
    assert.ok(problemsIn([entry]).length, `${entry} should be refused`);
  }
});

test('a file just outside the allowlist is refused even if it looks harmless', () => {
  // README.md and LICENSE are not secret, but shipping anything unlisted means the list is not
  // doing its job.
  for (const entry of ['README.md', 'LICENSE', 'privacy.html']) {
    assert.ok(problemsIn([entry]).length, `${entry} should be refused`);
  }
});

test('a directory named like an allowed root but longer is refused', () => {
  // "libs/" must not pass because "lib" is allowed.
  assert.ok(problemsIn(['libs/thing.js']).length);
  assert.ok(problemsIn(['srcs/thing.js']).length);
  assert.deepEqual(problemsIn(['lib/thing.js']), []);
});

test('auditZip accepts a real archive built from the allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voxly-audit-'));
  try {
    for (const d of PACKAGED.filter((p) => !p.includes('.'))) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'src/main.js'), '// x');
    const zip = join(dir, 'good.zip');
    execFileSync('zip', ['-qr9', zip, 'manifest.json', 'src'], { cwd: dir });
    assert.match(auditZip(zip), /files, nothing but/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('auditZip throws on a real archive carrying node_modules, and says what to do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voxly-audit-'));
  try {
    mkdirSync(join(dir, 'node_modules/pdfjs-dist/legacy/build'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{}');
    writeFileSync(join(dir, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'), '// core-js lives here');
    const zip = join(dir, 'bad.zip');
    execFileSync('zip', ['-qr9', zip, 'manifest.json', 'node_modules'], { cwd: dir });
    assert.throws(() => auditZip(zip), (e) => {
      assert.match(e.message, /do not belong/);
      assert.match(e.message, /npm run zip/, 'must tell the reader how to build it properly');
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Version 3.4.0 was rejected a second time, citing
// node_modules/pdfjs-dist/legacy/image_decoders/pdf.image_decoders.min.mjs — again a file the
// package never contained. But the package did still carry the minified pdf.js builds and a
// 2 MB minified bundle of our own, which is the next thing a reviewer would point at, so the
// build now vendors the unminified builds and this rule keeps them that way.

test('a minified script is refused, and the message says what to do instead', () => {
  const minified = 'var a=1,b=2,c=3;' + 'function f(x){return x+1}'.repeat(50);
  const problem = minificationProblem('lib/pdf.mjs', minified);
  assert.ok(problem, 'a one-line 1KB file should be refused');
  assert.match(problem, /characters per line/);
  assert.match(problem, /unminified build/, 'must say how to fix it');
});

test('ordinary source passes', () => {
  const source = ['// Reads a page.', 'export function read(doc) {', '  return doc.body.textContent;', '}'].join('\n');
  assert.equal(minificationProblem('src/content/reader.js', source), null);
});

test('only scripts are judged', () => {
  // A WASM blob or a licence file has no lines to speak of and is not code anyone reads.
  assert.equal(minificationProblem('ort/ort-wasm-simd-threaded.wasm', 'x'.repeat(5000)), null);
  assert.equal(minificationProblem('lib/pdfjs-LICENSE', 'x'.repeat(5000)), null);
});

test("emscripten's WASM glue is allowed, because upstream ships no other form of it", () => {
  const glue = 'x'.repeat(5000);
  assert.equal(minificationProblem('ort/ort-wasm-simd-threaded.mjs', glue), null);
  assert.equal(minificationProblem('ort/ort-wasm-simd-threaded.jsep.mjs', glue), null);
  // The exemption is for that glue only, not for anything parked in ort/.
  assert.ok(minificationProblem('ort/something-else.mjs', glue));
});

test('the package as it stands right now is readable', () => {
  // The real thing, not a fixture: whatever is in lib/, ort/ and src/ at this moment.
  assert.deepEqual(unreadableScripts(join(import.meta.dirname, '..')), []);
});
