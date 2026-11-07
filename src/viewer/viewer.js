// The PDF reader: a file in, the ordinary Voxly reader out.
//
// pdf.js gives us positioned text runs; src/viewer/pdf-layout.js infers paragraphs from their
// geometry; src/doc/model.js builds the same document model a web page produces; and
// src/doc/session.js opens the same reader view and talks to the same service worker. Nothing
// downstream knows this came from a PDF.
//
// Reading starts after the first few pages rather than after the whole file. A long book would
// otherwise sit in silence for tens of seconds while every page was extracted — the same mistake
// the natural voice used to make. The rest is extracted behind the playhead and appended as it
// arrives.
//
// Text extraction only: no page is ever rendered, because reading aloud needs no pixels.
import * as pdfjs from '../../lib/pdf.mjs';
import { openEpub, blocksOfChapter } from './epub.js';

// The worker ships inside the extension; nothing is fetched from a CDN.
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

const FIRST_PAGES = 6;  // enough to start reading from
const BATCH = 10;       // pages per background batch; >= 3 so running heads can be spotted

const el = {
  drop: document.getElementById('drop'),
  pick: document.getElementById('pick'),
  file: document.getElementById('file'),
  status: document.getElementById('status')
};

let session = null;
let run = 0;            // cancels a background extraction when another file is opened

const say = (text, isError = false) => {
  el.status.textContent = text;
  el.status.classList.toggle('error', isError);
};

el.pick.addEventListener('click', () => el.file.click());
el.file.addEventListener('change', () => { if (el.file.files[0]) load(el.file.files[0]); });

for (const type of ['dragenter', 'dragover']) {
  el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
}
for (const type of ['dragleave', 'drop']) {
  el.drop.addEventListener(type, () => el.drop.classList.remove('over'));
}
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) load(file);
});

const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
const isEpub = (f) => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip';

async function load(file) {
  const mine = ++run;
  if (session) { session.close(); session = null; }
  const kind = isPdf(file) ? 'PDF' : isEpub(file) ? 'EPUB' : null;
  if (!kind) {
    return say(`${file.name} is not a PDF or an EPUB. Voxly reads those two, and web pages.`, true);
  }
  say(`Opening ${file.name}\u2026`);
  try {
    if (kind === 'PDF') await readPdf(file, mine);
    else await readEpub(file, mine);
  } catch (e) {
    if (mine !== run) return; // superseded by another file
    console.error(`[voxly] ${kind} failed`, e);
    say(`Could not read that ${kind}: ${e.message}`, true);
  }
}

/**
 * An EPUB carries its own reading order, so there is no geometry to infer — just unzip, then
 * parse chapters into blocks. Parsing is batched for the same reason PDF extraction is: a long
 * book should start reading before all of it has been through DOMParser.
 */
async function readEpub(file, mine) {
  const { title, docs } = openEpub(new Uint8Array(await file.arrayBuffer()));
  if (mine !== run) return;

  // A first slice: chapters until there is enough to read, since a title page may hold two words.
  const blocks = [];
  let next = 0;
  while (next < docs.length && blocks.reduce((n, b) => n + b.text.length, 0) < 600) {
    blocks.push(...blocksOfChapter(docs[next].text));
    next++;
  }
  const doc = VX.model.buildModel({
    title: title || file.name.replace(/\.epub$/i, ''),
    site: 'EPUB',
    blocks
  });
  if (mine !== run) return;
  if (!doc.sentences.length) {
    return say('No readable text found in that EPUB.', true);
  }
  session = VX.createSession(doc, { onClosed: () => { session = null; } });
  say(next < docs.length
    ? `Reading ${file.name} \u2014 chapter ${next} of ${docs.length}\u2026`
    : `${file.name}: ${doc.sentences.length} sentences.`);

  // The remaining chapters, appended behind the playhead.
  for (; next < docs.length; next++) {
    if (mine !== run || !session || session.closed) return;
    session.extend(blocksOfChapter(docs[next].text));
    say(next + 1 < docs.length
      ? `Reading ${file.name} \u2014 chapter ${next + 1} of ${docs.length}\u2026`
      : `${file.name}: all ${docs.length} chapters read in.`);
    await new Promise((r) => setTimeout(r, 0)); // let the reader breathe between chapters
  }
}

async function readPdf(file, mine) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,  // our CSP allows no eval
    disableFontFace: true    // text extraction needs no fonts
  });
  const pdf = await task.promise;
  try {
    const title = await titleOf(pdf, file);
    const total = pdf.numPages;

    // First slice: enough to open the reader on.
    const head = Math.min(FIRST_PAGES, total);
    say(`Reading ${file.name}\u2026 page 1 of ${total}`);
    const doc = VX.model.buildModel({
      title,
      site: 'PDF',
      blocks: VX.pdfLayout.blocksFromPages(await pagesOf(pdf, 1, head, mine, file, total))
    });
    if (mine !== run) return;

    if (!doc.sentences.length && head >= total) {
      return say('No text found in that PDF. It may be a scan of pages rather than text, which Voxly cannot read yet.', true);
    }
    session = VX.createSession(doc, { onClosed: () => { session = null; } });
    say(total > head ? `Reading ${file.name} \u2014 still extracting page ${head} of ${total}\u2026` : `${file.name}: ${doc.sentences.length} sentences.`);

    // The rest, appended behind the playhead.
    for (let next = head + 1; next <= total; next += BATCH) {
      if (mine !== run || session?.closed) return;
      const last = Math.min(next + BATCH - 1, total);
      const blocks = VX.pdfLayout.blocksFromPages(await pagesOf(pdf, next, last, mine, file, total));
      if (mine !== run || !session || session.closed) return;
      session.extend(blocks);
      say(last < total ? `Reading ${file.name} \u2014 still extracting page ${last} of ${total}\u2026` : `${file.name}: all ${total} pages extracted.`);
    }
  } finally {
    // destroy() belongs to the loading task, not the document. Cleanup must never be able to turn
    // a successful read into a failure, so it is swallowed.
    try { await task.destroy(); } catch (e) { console.warn('[voxly] pdf cleanup', e); }
  }
}

/** Positioned text runs for pages `from`..`to` inclusive. */
async function pagesOf(pdf, from, to, mine, file, total) {
  const pages = [];
  for (let n = from; n <= to; n++) {
    if (mine !== run) return pages;
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items.filter((it) => 'str' in it).map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width,
      h: it.height || Math.abs(it.transform[3]) || 10
    })));
    page.cleanup();
    if (!session) say(`Reading ${file.name}\u2026 page ${n} of ${total}`);
  }
  return pages;
}

async function titleOf(pdf, file) {
  const fallback = file.name.replace(/\.pdf$/i, '');
  try {
    const meta = await pdf.getMetadata();
    return (meta?.info?.Title || '').trim() || fallback;
  } catch {
    return fallback;
  }
}

say('');
