// Turns the current web page into the shared document model.
// Readability finds the article; src/doc/model.js does the rest, so a PDF or EPUB opened in the
// viewer goes through exactly the same model-building code.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.extract) return;

  const { clean, blocksFrom, buildModel } = VX.model;

  function pickRoot(doc) {
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = doc.querySelector(sel);
      if (el && el.textContent.trim().length > 600) return el;
    }
    return doc.body;
  }

  /** Start where the reader selected text, if they did. */
  function findStart(sentences) {
    const sel = clean(String(window.getSelection() || ''));
    if (sel.length < 3) return 0;
    const probe = sel.slice(0, 40);
    const i = sentences.findIndex((s) => s.includes(probe) || probe.includes(s.slice(0, 40)));
    return i < 0 ? 0 : i;
  }

  VX.extract = function extract() {
    let title = document.title, blocks = [];
    // What the page is showing, not its raw DOM: visible elements only, with shadow roots and same-origin
    // iframes flattened in (see snapshot.js). Readability mutates what it gets; the snapshot is ours to spend.
    const { doc: shown, crossOrigin } = VX.snapshot();
    try {
      const article = new Readability(shown.cloneNode(true), { charThreshold: 300 }).parse();
      if (article?.content) {
        title = article.title || title;
        // DOMParser documents are inert: no scripts run, no images load.
        blocks = blocksFrom(new DOMParser().parseFromString(article.content, 'text/html').body);
      }
    } catch (e) { console.warn('[voxly] Readability failed, using page text', e); }
    if (blocks.reduce((n, b) => n + b.text.length, 0) < 200) blocks = blocksFrom(pickRoot(shown));

    // The content lives in a frame from another site, which a content script here can't read.
    // Say so plainly rather than reading whatever scraps of the outer page are left.
    if (blocks.reduce((n, b) => n + b.text.length, 0) < 200 && crossOrigin.length) {
      const host = new URL(crossOrigin[0].src).hostname;
      blocks = [{ kind: 'text', text: `This page shows its content in a frame from ${host}, which Voxly can't read from here. ` +
        'Right-click the content, choose Open frame in new tab, then start Voxly on that tab.' }];
    }

    const doc = buildModel({
      title,
      site: location.hostname.replace(/^www\./, ''),
      blocks,
      lang: document.documentElement.lang || undefined
    });
    doc.startAt = findStart(doc.sentences);
    return doc;
  };
})();
