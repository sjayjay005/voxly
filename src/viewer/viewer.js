// The PDF reader: a file in, the ordinary Voxly reader out.
//
// pdf.js gives us positioned text runs; src/viewer/pdf-layout.js infers paragraphs from their
// geometry; src/doc/model.js builds the same document model a web page produces; and
// src/doc/session.js opens the same reader view and talks to the same service worker. Nothing
// downstream knows this came from a PDF.
//
// Text extraction only — no page is ever rendered, because reading aloud does not need pixels.
import * as pdfjs from '../../lib/pdf.mjs';

// The worker ships inside the extension; nothing is fetched from a CDN.
pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.mjs');

const el = {
  drop: document.getElementById('drop'),
  pick: document.getElementById('pick'),
  file: document.getElementById('file'),
  status: document.getElementById('status')
};

let session = null;

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

async function load(file) {
  if (session) { session.close(); session = null; }
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    return say(`${file.name} is not a PDF. EPUB support is coming; for now Voxly reads PDFs and web pages.`, true);
  }
  say(`Reading ${file.name}…`);
  try {
    const doc = await extract(file);
    if (!doc.sentences.length) {
      return say('No text found in that PDF. It may be a scan of pages rather than text, which Voxly cannot read yet.', true);
    }
    say(`${doc.sentences.length} sentences from ${file.name}.`);
    session = VX.createSession(doc, { onClosed: () => { session = null; } });
  } catch (e) {
    console.error('[voxly] PDF failed', e);
    say(`Could not read that PDF: ${e.message}`, true);
  }
}

/** PDF file -> the shared document model. */
async function extract(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({
    data,
    isEvalSupported: false,  // our CSP allows no eval
    disableFontFace: true    // text extraction needs no fonts
  }).promise;

  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
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
    if (n % 10 === 0) say(`Reading ${file.name}… page ${n} of ${pdf.numPages}`);
  }

  const title = await pdf.getMetadata()
    .then((m) => (m?.info?.Title || '').trim())
    .catch(() => '');
  pdf.destroy();

  return VX.model.buildModel({
    title: title || file.name.replace(/\.pdf$/i, ''),
    site: 'PDF',
    blocks: VX.pdfLayout.blocksFromPages(pages)
  });
}

// Opened with ?file= from the service worker one day; for now the landing state is the drop zone.
say('');
