// Reading an EPUB.
//
// An EPUB is a ZIP with a reading order written down inside it, which makes it far less work
// than a PDF: the chapters are XHTML, so once they are unzipped the same blocksFrom() that
// handles a web page handles them too. No geometry to infer.
//
//   META-INF/container.xml  ->  where the package file is
//   the package file (.opf) ->  the title, a manifest of ids to files, and the spine order
//   each spine document     ->  XHTML, parsed and reduced to blocks
//
// Only the textual entries are decompressed. An EPUB is mostly images, and we need none of them.
import { unzipSync, strFromU8 } from '../../lib/fflate.js';

const TEXTUAL = /\.(x?html?|opf|ncx|xml)$/i;
const DC = 'http://purl.org/dc/elements/1.1/';

/** Directory part of a zip path, '' at the root. */
export const dirOf = (path) => path.split('/').slice(0, -1).join('/');

/**
 * Resolve an href from the manifest against the package file's directory, the way a zip path
 * works: forward slashes, no leading slash, '..' climbing. Hrefs are URL-encoded and may carry a
 * fragment, neither of which belongs in a zip lookup. Getting this wrong is the classic reason an
 * EPUB reader finds no chapters, so it is pure and tested.
 */
export function resolvePath(baseDir, href) {
  let clean = String(href || '').split('#')[0].split('?')[0];
  try { clean = decodeURIComponent(clean); } catch { /* leave it as written */ }
  if (!clean) return '';
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Turn a package file's parts into the list of chapter paths, in reading order.
 * Takes plain data rather than a DOM so it can be tested without a browser.
 */
export function packageFrom({ title = '', manifest, spine = [], opfPath = '' }) {
  const base = dirOf(opfPath);
  const docs = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item) continue;
    // Skip anything that is not a content document — images, styles, audio.
    if (item.type && !/x?html/i.test(item.type)) continue;
    const path = resolvePath(base, item.href);
    if (path && !docs.includes(path)) docs.push(path);
  }
  return { title: String(title).trim(), docs };
}

const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');

function rootfileOf(container) {
  const el = container.getElementsByTagName('rootfile')[0];
  return el?.getAttribute('full-path') || '';
}

/** Pull the title, manifest and spine out of a parsed package file. */
function readPackage(opf, opfPath) {
  const title = opf.getElementsByTagNameNS(DC, 'title')[0]?.textContent
    || opf.getElementsByTagName('dc:title')[0]?.textContent
    || '';
  const manifest = new Map();
  for (const item of opf.getElementsByTagName('item')) {
    const id = item.getAttribute('id');
    if (id) manifest.set(id, { href: item.getAttribute('href') || '', type: item.getAttribute('media-type') || '' });
  }
  const spine = [];
  for (const ref of opf.getElementsByTagName('itemref')) {
    // linear="no" is front or back matter outside the reading order.
    if (ref.getAttribute('linear') === 'no') continue;
    const id = ref.getAttribute('idref');
    if (id) spine.push(id);
  }
  return { title, manifest, spine, opfPath };
}

/**
 * Unzip an EPUB and return its chapters as text, in reading order. Throws with something a
 * person can act on when the archive is not what it claims to be.
 */
export function openEpub(bytes) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => TEXTUAL.test(f.name) });
  } catch (e) {
    throw new Error(`this file is not a readable ZIP archive (${e.message})`);
  }
  const read = (p) => (files[p] ? strFromU8(files[p]) : null);

  const container = read('META-INF/container.xml');
  if (!container) throw new Error('not an EPUB: META-INF/container.xml is missing');
  const opfPath = rootfileOf(parseXml(container));
  if (!opfPath) throw new Error('this EPUB does not say where its package file is');
  const opf = read(opfPath);
  if (!opf) throw new Error(`the package file (${opfPath}) is missing from the archive`);

  const pkg = packageFrom(readPackage(parseXml(opf), opfPath));
  const docs = pkg.docs.map((path) => ({ path, text: read(path) })).filter((d) => d.text);
  if (!docs.length) throw new Error('no readable chapters found in this EPUB');
  return { title: pkg.title, docs };
}

/**
 * One chapter's XHTML to blocks, reusing the same extraction a web page gets. XHTML is meant to
 * be well-formed but often is not, so fall back to the forgiving HTML parser.
 */
export function blocksOfChapter(text) {
  const parser = new DOMParser();
  let doc = parser.parseFromString(text, 'application/xhtml+xml');
  if (!doc?.body || doc.getElementsByTagName('parsererror').length) {
    doc = parser.parseFromString(text, 'text/html');
  }
  return doc?.body ? VX.model.blocksFrom(doc.body) : [];
}
