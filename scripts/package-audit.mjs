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
