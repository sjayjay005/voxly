// Turns the current page into a small document model:
//   { title, site, blocks: [{ kind, sentences: [{ text, index }] }], sentences: string[], startAt }
// Readability finds the article; we then keep only leaf text blocks and split them into sentences.
// Sentences are the unit of everything downstream: playback, highlighting, seeking.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.extract) return;

  const LEAF = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt,figcaption';
  const MAX_SENTENCE = 240; // keeps every utterance inside what Chrome's online voices handle without cutting out

  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  // Page furniture that article extractors often keep: reading times, dates, photo credits, share prompts.
  const NOISE = [
    /^\d+\s*(min|minute)s?\s*(read|listen)$/i,
    /^(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i,
    /^(photo|image|illustration|picture)\s*(by|:|credit|via|courtesy)/i,
    /^(share|listen|follow|subscribe|sign up|sign in|advertisement|sponsored|read more|related)\b.{0,20}$/i,
    /^(updated|published|posted)\s.{0,40}$/i
  ];
  const isNoise = (t) => t.length < 80 && NOISE.some((r) => r.test(t));

  function blocksFrom(root) {
    const blocks = [];
    for (const el of root.querySelectorAll(LEAF)) {
      if (el.querySelector(LEAF)) continue; // only leaves: a <li> wrapping a <p> is read once, via the <p>
      if (el.closest('nav,aside,footer,figure > :not(figcaption),[aria-hidden="true"]')) continue;
      const text = clean(el.textContent || '');
      if (!text) continue;
      if (el.tagName === 'FIGCAPTION' && isNoise(text)) continue;
      const tag = el.tagName.toLowerCase();
      const kind = /^h[1-6]$/.test(tag) ? 'heading' : tag === 'li' ? 'item' : tag === 'blockquote' ? 'quote' : tag === 'pre' ? 'code' : 'text';
      if (kind === 'text' && (text.length < 3 || isNoise(text))) continue;
      blocks.push({ kind, text });
    }
    return blocks;
  }

  function pickRoot() {
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 600) return el;
    }
    return document.body;
  }

  function splitSentences(text, lang) {
    let parts;
    try { parts = [...new Intl.Segmenter(lang, { granularity: 'sentence' }).segment(text)].map((s) => s.segment.trim()); }
    catch { parts = text.split(/(?<=[.!?])\s+/); }
    const out = [];
    for (let s of parts.filter(Boolean)) {
      while (s.length > MAX_SENTENCE) {
        // Split overlong sentences at the last clause boundary inside the window, else at a space.
        const win = s.slice(0, MAX_SENTENCE);
        let cut = Math.max(win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(' — '), win.lastIndexOf(', '));
        if (cut < MAX_SENTENCE * 0.4) cut = win.lastIndexOf(' ');
        if (cut <= 0) cut = MAX_SENTENCE - 1;
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if (s) out.push(s);
    }
    // Fold fragments like "Yes." into the next sentence so they don't sound clipped.
    const merged = [];
    for (const s of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.length < 12 && prev.length + s.length < MAX_SENTENCE) merged[merged.length - 1] = prev + ' ' + s;
      else merged.push(s);
    }
    return merged;
  }

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

    const lang = document.documentElement.lang || undefined;
    const sentences = [];
    const model = [];
    if (title) {
      model.push({ kind: 'title', sentences: [{ text: clean(title), index: 0 }] });
      sentences.push(clean(title));
      // Readability often repeats the title as the first heading.
      if (blocks[0] && clean(blocks[0].text) === clean(title)) blocks.shift();
    }
    for (const b of blocks) {
      const ss = b.kind === 'code' ? [b.text.slice(0, MAX_SENTENCE)] : splitSentences(b.text, lang);
      model.push({ kind: b.kind, sentences: ss.map((text) => ({ text, index: sentences.push(text) - 1 })) });
    }
    return { title: clean(title), site: location.hostname.replace(/^www\./, ''), blocks: model, sentences, startAt: findStart(sentences) };
  };
})();
