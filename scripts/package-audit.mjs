// What may go into the Chrome Web Store package, and what must never.
//
// Version 3.0.0 was rejected for "having obfuscated code in the package", citing
// node_modules/pdfjs-dist/legacy/build/pdf.mjs. None of that is code Voxly ships or uses — the
// vendored copy is the modern build in lib/ — so the package had been made by zipping the
// project folder rather than the extension. pdfjs-dist/legacy/ bundles core-js, whose
// NullProtoObject writes a script into an iframe through a javascript: URL, and the Web Store
// reads that as concealed functionality.
//
// The entry list is checked rather than trusted, and the check is pure so it can be tested.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Everything the extension is. Nothing else may appear in the archive. */
export const PACKAGED = ['manifest.json', 'icons', 'lib', 'ort', 'src'];

const FORBIDDEN = [
  [/(^|\/)node_modules(\/|$)/, 'dependency sources — the extension ships vendored copies in lib/ and ort/'],
  [/\.map$/, 'source maps'],
  [/(^|\/)\.[^/]/, 'dotfiles'],
  [/^(dist|scripts|test)(\/|$)/, 'build and test files'],
  [/^package(-lock)?\.json$/, 'npm manifests']
];

/**
 * Everything wrong with a list of archive entries, as sentences a person can act on.
 * Empty means the archive is shippable.
 */
export function problemsIn(entries) {
  const problems = [];
  for (const entry of entries) {
    for (const [pattern, why] of FORBIDDEN) {
      if (pattern.test(entry)) problems.push(`${entry} — ${why}`);
    }
    if (!PACKAGED.some((r) => entry === r || entry.startsWith(r + '/'))) {
      problems.push(`${entry} — not one of ${PACKAGED.join(', ')}`);
    }
  }
  return problems;
}

export const entriesOf = (zip) =>
  execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n').filter(Boolean);

/** Throw unless the archive contains exactly the extension. Returns a one-line summary. */
export function auditZip(zip) {
  const entries = entriesOf(zip);
  const problems = problemsIn(entries);
  if (problems.length) {
    throw new Error(
      `refusing to ship ${problems.length} file(s) that do not belong in the extension:\n  `
      + problems.slice(0, 12).join('\n  ')
      + (problems.length > 12 ? `\n  ...and ${problems.length - 12} more` : '')
      + '\n\nBuild the package with `npm run zip`; do not zip the project folder.'
    );
  }
  const dirs = [...new Set(entries.map((e) => e.split('/')[0]))].sort();
  return `${entries.length} files, nothing but ${dirs.join(', ')}`;
}

// --- Readability -------------------------------------------------------------------------
//
// The same policy also forbids shipping code a reviewer cannot read. Minification is not
// obfuscation, but a 45,000-character line is indistinguishable from one at a glance, and
// arguing the difference with a reviewer is a worse use of a week than shipping the readable
// build. So: every script in the package is the unminified one, and this proves it.

/** Average characters per line above which a file reads as a blob rather than as source. */
const READABLE_LINE_LENGTH = 200;

/**
 * Emscripten's WASM loader glue, which upstream publishes in no other form. It is generated,
 * long-lined, and unavoidable — the alternative is not shipping the neural voice at all.
 */
const GENERATED_GLUE = [/^ort\/ort-wasm[\w.-]*\.mjs$/];

/**
 * Why a script reads as minified, or null if it reads fine. Pure, so the rule is testable
 * without building anything.
 */
export function minificationProblem(path, source) {
  if (!/\.m?js$/.test(path)) return null;
  if (GENERATED_GLUE.some((p) => p.test(path))) return null;
  const lines = source.split('\n').length;
  const perLine = Math.round(source.length / lines);
  if (perLine <= READABLE_LINE_LENGTH) return null;
  return `${path} — ${perLine} characters per line across ${lines} lines, which reads as minified;`
    + ' vendor the unminified build so a reviewer can read it';
}

const scriptsUnder = (root, rel) => {
  const abs = join(root, rel);
  if (!statSync(abs).isDirectory()) return /\.m?js$/.test(rel) ? [rel] : [];
  return readdirSync(abs).flatMap((name) => scriptsUnder(root, rel + '/' + name));
};

/** Every script in the package that a reviewer could not read. Empty means the package is clear. */
export function unreadableScripts(root) {
  return PACKAGED
    .flatMap((entry) => scriptsUnder(root, entry))
    .map((rel) => minificationProblem(rel, readFileSync(join(root, rel), 'utf8')))
    .filter(Boolean);
}

/** Throw unless every script in the package is readable. Returns a one-line summary. */
export function auditReadability(root) {
  const problems = unreadableScripts(root);
  if (problems.length) {
    throw new Error(
      `refusing to ship ${problems.length} unreadable file(s):\n  ` + problems.join('\n  ')
      + '\n\nThe Chrome Web Store Code Readability policy rejected 3.0.0 and 3.4.0 over this.'
    );
  }
  return 'every script in the package is readable';
}
