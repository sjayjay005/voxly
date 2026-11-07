// Tests for the EPUB path resolution and spine ordering.
//
// Hrefs in a package file are relative to that file's own directory, URL-encoded, and may carry
// a fragment — and the lookup they feed is a flat map of zip entry names. Getting it wrong is
// the classic reason an EPUB reader reports no chapters, so it is pure and covered here. The XML
// reading itself needs a DOMParser and belongs to the browser pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePath, dirOf, packageFrom } from '../src/viewer/epub.js';

test('dirOf gives the directory part, empty at the archive root', () => {
  assert.equal(dirOf('OEBPS/content.opf'), 'OEBPS');
  assert.equal(dirOf('a/b/c/package.opf'), 'a/b/c');
  assert.equal(dirOf('content.opf'), '');
});

test('resolvePath resolves against the package file directory', () => {
  assert.equal(resolvePath('OEBPS', 'chapter1.xhtml'), 'OEBPS/chapter1.xhtml');
  assert.equal(resolvePath('OEBPS/text', 'ch1.xhtml'), 'OEBPS/text/ch1.xhtml');
  assert.equal(resolvePath('', 'ch1.xhtml'), 'ch1.xhtml');
});

test('resolvePath climbs out of the package directory', () => {
  assert.equal(resolvePath('OEBPS/text', '../images/../ch1.xhtml'), 'OEBPS/ch1.xhtml');
  assert.equal(resolvePath('OEBPS/text', '../../ch1.xhtml'), 'ch1.xhtml');
  assert.equal(resolvePath('OEBPS', './ch1.xhtml'), 'OEBPS/ch1.xhtml');
});

test('resolvePath drops a fragment and a query', () => {
  assert.equal(resolvePath('OEBPS', 'ch1.xhtml#section-2'), 'OEBPS/ch1.xhtml');
  assert.equal(resolvePath('OEBPS', 'ch1.xhtml?v=2'), 'OEBPS/ch1.xhtml');
});

test('resolvePath decodes the escaping a zip entry name will not have', () => {
  assert.equal(resolvePath('OEBPS', 'chapter%201.xhtml'), 'OEBPS/chapter 1.xhtml');
  assert.equal(resolvePath('OEBPS', 'caf%C3%A9.xhtml'), 'OEBPS/café.xhtml');
});

test('resolvePath survives href nonsense rather than throwing', () => {
  assert.equal(resolvePath('OEBPS', ''), '');
  assert.equal(resolvePath('OEBPS', undefined), '');
  // A stray percent is not valid escaping; keep the literal rather than blowing up.
  assert.equal(resolvePath('OEBPS', '100%.xhtml'), 'OEBPS/100%.xhtml');
});

test('resolvePath treats an absolute href as archive-relative', () => {
  assert.equal(resolvePath('OEBPS', '/OEBPS/ch1.xhtml'), 'OEBPS/ch1.xhtml');
});

const manifest = (entries) => new Map(Object.entries(entries));

test('packageFrom returns chapters in spine order, not manifest order', () => {
  const pkg = packageFrom({
    title: '  A Book  ',
    opfPath: 'OEBPS/content.opf',
    manifest: manifest({
      c2: { href: 'ch2.xhtml', type: 'application/xhtml+xml' },
      c1: { href: 'ch1.xhtml', type: 'application/xhtml+xml' },
      c3: { href: 'ch3.xhtml', type: 'application/xhtml+xml' }
    }),
    spine: ['c1', 'c2', 'c3']
  });
  assert.equal(pkg.title, 'A Book', 'title is trimmed');
  assert.deepEqual(pkg.docs, ['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml', 'OEBPS/ch3.xhtml']);
});

test('packageFrom skips anything that is not a content document', () => {
  const pkg = packageFrom({
    opfPath: 'content.opf',
    manifest: manifest({
      cover: { href: 'cover.jpg', type: 'image/jpeg' },
      css: { href: 'style.css', type: 'text/css' },
      c1: { href: 'ch1.xhtml', type: 'application/xhtml+xml' }
    }),
    spine: ['cover', 'css', 'c1']
  });
  assert.deepEqual(pkg.docs, ['ch1.xhtml']);
});

test('packageFrom ignores spine entries with no manifest item', () => {
  const pkg = packageFrom({
    opfPath: 'content.opf',
    manifest: manifest({ c1: { href: 'ch1.xhtml', type: 'application/xhtml+xml' } }),
    spine: ['missing', 'c1', 'alsoMissing']
  });
  assert.deepEqual(pkg.docs, ['ch1.xhtml']);
});

test('packageFrom keeps an item whose media type is unstated', () => {
  // Some older EPUBs omit media-type; refusing those would lose the whole book.
  const pkg = packageFrom({
    opfPath: 'content.opf',
    manifest: manifest({ c1: { href: 'ch1.html', type: '' } }),
    spine: ['c1']
  });
  assert.deepEqual(pkg.docs, ['ch1.html']);
});

test('packageFrom does not list the same file twice', () => {
  // A spine may point two itemrefs at one file via different ids, or repeat an id.
  const pkg = packageFrom({
    opfPath: 'content.opf',
    manifest: manifest({
      a: { href: 'ch1.xhtml', type: 'application/xhtml+xml' },
      b: { href: 'ch1.xhtml', type: 'application/xhtml+xml' }
    }),
    spine: ['a', 'b', 'a']
  });
  assert.deepEqual(pkg.docs, ['ch1.xhtml']);
});

test('packageFrom copes with an empty spine', () => {
  const pkg = packageFrom({ opfPath: 'content.opf', manifest: manifest({}), spine: [] });
  assert.deepEqual(pkg.docs, []);
  assert.equal(pkg.title, '');
});
