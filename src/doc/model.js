// Turning text into the document model everything downstream speaks:
//   { title, site, blocks: [{ kind, sentences: [{ text, index }] }], sentences: string[], blockStarts, startAt }
//
// Sentences are the unit of everything: playback, highlighting, seeking, caching and resume all
// address the flat `sentences` array by index.
//
// This file knows nothing about where the text came from. A web page goes through
// src/reader/extract.js, a PDF or EPUB through src/viewer/. Both end up here, which is why the
// reader UI works identically for all of them.
//
// Loaded as a plain script (content scripts cannot use import), so it hangs itself off VX.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.model) return;

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

  const kindOf = (tag) =>
    /^h[1-6]$/.test(tag) ? 'heading'
    : tag === 'li' ? 'item'
    : tag === 'blockquote' ? 'quote'
    : tag === 'pre' ? 'code'
    : 'text';

  /** Leaf text blocks of a DOM tree. Works on a live document and on a DOMParser one (EPUB). */
  function blocksFrom(root) {
    const blocks = [];
    for (const el of root.querySelectorAll(LEAF)) {
      if (el.querySelector(LEAF)) continue; // only leaves: a <li> wrapping a <p> is read once, via the <p>
      if (el.closest('nav,aside,footer,figure > :not(figcaption),[aria-hidden="true"]')) continue;
      const text = clean(el.textContent || '');
      if (!text) continue;
      if (el.tagName === 'FIGCAPTION' && isNoise(text)) continue;
      const kind = kindOf(el.tagName.toLowerCase());
      if (kind === 'text' && (text.length < 3 || isNoise(text))) continue;
      blocks.push({ kind, text });
    }
    return blocks;
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
        let cut = Math.max(win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(' \u2014 '), win.lastIndexOf(', '));
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

  /**
   * Assemble the model from a title and a flat list of { kind, text } blocks.
   * `startAt` is left at 0; a caller that knows better (a text selection, a saved position)
   * sets it afterwards.
   */
  function buildModel({ title = '', site = '', blocks = [], lang } = {}) {
    const sentences = [];
    const model = [];
    const cleanTitle = clean(title);
    const rest = blocks.slice();
    if (cleanTitle) {
      model.push({ kind: 'title', sentences: [{ text: cleanTitle, index: 0 }] });
      sentences.push(cleanTitle);
      // Extractors often repeat the title as the first heading.
      if (rest[0] && clean(rest[0].text) === cleanTitle) rest.shift();
    }
    for (const b of rest) {
      const ss = b.kind === 'code' ? [b.text.slice(0, MAX_SENTENCE)] : splitSentences(b.text, lang);
      model.push({ kind: b.kind, sentences: ss.map((text) => ({ text, index: sentences.push(text) - 1 })) });
    }
    // The first sentence of each block, so playback can change voice at a paragraph break
    // rather than mid-thought.
    const blockStarts = model.map((b) => b.sentences[0]?.index).filter((i) => i != null);
    return { title: cleanTitle, site, blocks: model, sentences, blockStarts, startAt: 0 };
  }

  VX.model = { LEAF, MAX_SENTENCE, clean, isNoise, kindOf, blocksFrom, splitSentences, buildModel };
})();
