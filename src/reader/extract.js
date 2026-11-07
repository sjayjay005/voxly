// Turns the current web page into the shared document model.
// Readability finds the article; src/doc/model.js does the rest, so a PDF or EPUB opened in the
// viewer goes through exactly the same model-building code.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.extract) return;

  const { clean, blocksFrom, buildModel } = VX.model;

  function pickRoot() {
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 600) return el;
    }
    return document.body;
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
    try {
      // Readability mutates the document it gets, so it works on a clone. The clone is dropped right after.
      const article = new Readability(document.cloneNode(true), { charThreshold: 300 }).parse();
      if (article?.content) {
        title = article.title || title;
        // DOMParser documents are inert: no scripts run, no images load.
        blocks = blocksFrom(new DOMParser().parseFromString(article.content, 'text/html').body);
      }
    } catch (e) { console.warn('[voxly] Readability failed, using page text', e); }
    if (blocks.reduce((n, b) => n + b.text.length, 0) < 200) blocks = blocksFrom(pickRoot());

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
