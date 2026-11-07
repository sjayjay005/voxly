// Turning a PDF's positioned text runs into paragraphs.
//
// A PDF has no paragraphs — only glyphs at coordinates. pdf.js hands back text runs with a
// transform, so the structure has to be inferred from geometry: group runs into lines, then
// decide where one paragraph ends and the next begins from the vertical gaps, the line widths and
// the punctuation. Headers, footers and page numbers repeat at the same place on every page, so
// they can be found and dropped.
//
// Pure geometry in, { kind, text } blocks out — no pdf.js, no DOM — so it can be tested.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.pdfLayout) return;

  const median = (xs) => {
    if (!xs.length) return 0;
    const a = [...xs].sort((p, q) => p - q);
    return a[Math.floor(a.length / 2)];
  };
  const norm = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const endsSentence = (t) => /[.!?]["\u2019\u201d)\]]?$/.test(t);

  /** Group one page's runs into lines, top to bottom, each line's runs left to right. */
  function linesOf(items, pageIndex) {
    const runs = items.filter((it) => it.str && it.str.trim());
    if (!runs.length) return [];
    const tol = Math.max(1, median(runs.map((r) => r.h || 0)) * 0.5);
    const rows = [];
    for (const r of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const row = rows.find((g) => Math.abs(g.y - r.y) <= tol);
      if (row) { row.runs.push(r); row.y = (row.y * (row.runs.length - 1) + r.y) / row.runs.length; }
      else rows.push({ y: r.y, runs: [r] });
    }
    return rows.map((row) => {
      const runs = row.runs.sort((a, b) => a.x - b.x);
      // A gap wider than a space means a real space the PDF never wrote.
      let text = '';
      let prev = null;
      for (const r of runs) {
        if (prev) {
          const gap = r.x - (prev.x + (prev.w || 0));
          const needsSpace = gap > (prev.h || 10) * 0.2 && !/\s$/.test(text) && !/^\s/.test(r.str);
          if (needsSpace) text += ' ';
        }
        text += r.str;
        prev = r;
      }
      const x0 = runs[0].x;
      const last = runs[runs.length - 1];
      return {
        text: text.replace(/\s+/g, ' ').trim(),
        y: row.y, x0, x1: last.x + (last.w || 0),
        h: Math.max(...runs.map((r) => r.h || 0)),
        page: pageIndex
      };
    }).filter((l) => l.text);
  }

  const keyOf = (l) => norm(l.text) + '@' + Math.round(l.y / 6);

  /**
   * Lines that repeat in the same place across most pages are running heads, folios or footers.
   * Needs at least three pages to tell a repeated header from a coincidence.
   *
   * Only lines in the top or bottom margin are eligible. Normalising digits is what lets
   * "Chapter 3" and "Chapter 4" count as the same running head, but it also makes two body
   * paragraphs that differ only by a number look identical — so without the margin test, real
   * prose could be thrown away. Page furniture lives at the edges; prose does not.
   */
  function furniture(lines, pageCount, inMargin = () => true) {
    if (pageCount < 3) return new Set();
    const seen = new Map();
    for (const l of lines) {
      if (!inMargin(l)) continue;
      const key = keyOf(l);
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(l.page);
    }
    const repeated = new Set();
    for (const [key, pages] of seen) if (pages.size >= Math.max(3, pageCount * 0.6)) repeated.add(key);
    return repeated;
  }

  /** Top and bottom tenth of the text area, where headers and footers live. */
  function marginTest(lines) {
    const ys = lines.map((l) => l.y);
    const top = Math.max(...ys), bottom = Math.min(...ys);
    const span = top - bottom || 1;
    return (l) => (top - l.y) < span * 0.12 || (l.y - bottom) < span * 0.12;
  }

  const isPageNumber = (t) => /^[\[(]?(?:page\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})[\])]?$/i.test(t.trim());

  /** Join a continuation line onto a paragraph, undoing end-of-line hyphenation. */
  function join(para, text) {
    if (/[\u2010-]$/.test(para) && /^[a-z\u00df-\u00ff]/.test(text)) return para.slice(0, -1) + text;
    return para + ' ' + text;
  }

  /**
   * @param pages array of pages, each an array of { str, x, y, w, h }
   * @returns [{ kind, text }] ready for VX.model.buildModel
   */
  function blocksFromPages(pages) {
    const lines = pages.flatMap((items, i) => linesOf(items, i));
    if (!lines.length) return [];

    const inMargin = marginTest(lines);
    const drop = furniture(lines, pages.length, inMargin);
    const kept = lines.filter((l) => !(inMargin(l) && drop.has(keyOf(l))) && !isPageNumber(l.text));
    if (!kept.length) return [];

    const bodyH = median(kept.map((l) => l.h));
    const fullWidth = median(kept.map((l) => l.x1 - l.x0));
    const gaps = [];
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i - 1], b = kept[i];
      if (a.page === b.page && a.y > b.y) gaps.push(a.y - b.y);
    }
    const bodyGap = median(gaps) || bodyH * 1.2;

    const blocks = [];
    let para = null;
    const flush = () => { if (para && para.text.trim()) blocks.push({ kind: para.kind, text: para.text.trim() }); para = null; };

    for (let i = 0; i < kept.length; i++) {
      const l = kept[i];
      const prev = kept[i - 1];
      // A line noticeably larger than the body, and short, is a heading.
      const heading = bodyH > 0 && l.h > bodyH * 1.18 && (l.x1 - l.x0) < fullWidth * 1.1;

      let breakHere = !prev || heading || para?.kind === 'heading';
      if (!breakHere) {
        if (l.page !== prev.page) {
          // Across a page break, only start a paragraph if the previous one looked finished.
          breakHere = endsSentence(prev.text) && (prev.x1 - prev.x0) < fullWidth * 0.92;
        } else {
          const gap = prev.y - l.y;
          const indented = l.x0 > prev.x0 + bodyH * 0.8;
          const shortAndDone = (prev.x1 - prev.x0) < fullWidth * 0.85 && endsSentence(prev.text);
          breakHere = gap > bodyGap * 1.5 || indented || shortAndDone;
        }
      }

      if (breakHere) { flush(); para = { kind: heading ? 'heading' : 'text', text: l.text }; }
      else para.text = join(para.text, l.text);
    }
    flush();
    return blocks;
  }

  VX.pdfLayout = { blocksFromPages, linesOf, furniture, marginTest, isPageNumber, join, keyOf };
})();
