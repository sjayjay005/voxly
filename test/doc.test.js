// Tests for the shared document model and the PDF paragraph inference.
//
// Both are plain scripts rather than ES modules, because content scripts cannot use import. They
// attach themselves to a VX global, so the tests evaluate them the way a browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.VX = {};
// tab-mark.js touches document/MutationObserver at call time, not load time, so loading it here
// is safe; only its pure title helper is exercised.
globalThis.document = { title: '', querySelector: () => null, head: null };
for (const f of ['src/doc/model.js', 'src/viewer/pdf-layout.js', 'src/doc/tab-mark.js']) new Function(readFileSync(f, 'utf8'))();
const { splitSentences, buildModel, appendBlocks, clean, isNoise, MAX_SENTENCE } = globalThis.VX.model;
const { blocksFromPages, linesOf, isPageNumber, join } = globalThis.VX.pdfLayout;
const { markedTitle, strip, ICON } = globalThis.VX.tabMark;

// ---------------------------------------------------------------- model

test('clean collapses whitespace', () => {
  assert.equal(clean('  a \n b\t c '), 'a b c');
});

test('isNoise catches page furniture but not prose', () => {
  for (const t of ['5 min read', '2 hours ago', 'Photo by Someone', 'Published 3 January 2026'])
    assert.ok(isNoise(t), `should be noise: ${t}`);
  assert.ok(!isNoise('The minister read the report aloud to the chamber.'));
});

test('splitSentences splits on sentence boundaries', () => {
  assert.deepEqual(splitSentences('One thing happened. Then another thing did.', 'en'),
    ['One thing happened.', 'Then another thing did.']);
});

test('splitSentences keeps every utterance within the TTS limit', () => {
  const long = Array.from({ length: 40 }, (_, i) => `clause number ${i} of this run`).join(', ') + '.';
  for (const s of splitSentences(long, 'en')) assert.ok(s.length <= MAX_SENTENCE, `${s.length} > ${MAX_SENTENCE}`);
});

test('splitSentences folds a stub into the sentence after it', () => {
  // "Yes." alone would sound clipped, so it joins what follows.
  assert.deepEqual(splitSentences('Yes. The whole committee agreed with him.', 'en'),
    ['Yes. The whole committee agreed with him.']);
});

test('buildModel indexes sentences flatly and marks paragraph starts', () => {
  const doc = buildModel({
    title: 'A Title',
    site: 'example.com',
    blocks: [{ kind: 'text', text: 'The first sentence here. The second sentence here.' }, { kind: 'text', text: 'The third sentence here.' }],
    lang: 'en'
  });
  assert.deepEqual(doc.sentences,
    ['A Title', 'The first sentence here.', 'The second sentence here.', 'The third sentence here.']);
  assert.deepEqual(doc.blockStarts, [0, 1, 3], 'title, then each paragraph');
  assert.equal(doc.startAt, 0);
  assert.equal(doc.blocks[0].kind, 'title');
});

test('buildModel drops a first heading that just repeats the title', () => {
  const doc = buildModel({ title: 'Repeated', blocks: [{ kind: 'heading', text: 'Repeated' }, { kind: 'text', text: 'Body.' }] });
  assert.deepEqual(doc.sentences, ['Repeated', 'Body.']);
});

test('buildModel copes with no title and no blocks', () => {
  const doc = buildModel({});
  assert.deepEqual(doc.sentences, []);
  assert.deepEqual(doc.blockStarts, []);
});

test('buildModel does not split a code block into sentences', () => {
  const doc = buildModel({ blocks: [{ kind: 'code', text: 'a = 1. b = 2. c = 3.' }] });
  assert.equal(doc.sentences.length, 1);
});

test('appendBlocks keeps sentence indices contiguous as a document grows', () => {
  const doc = buildModel({ title: 'Long Book', blocks: [{ kind: 'text', text: 'The opening paragraph sits here.' }] });
  assert.equal(doc.sentences.length, 2);

  const added = appendBlocks(doc, [
    { kind: 'text', text: 'A later paragraph arrives. It has two sentences.' },
    { kind: 'heading', text: 'Chapter Two' }
  ], 'en');

  assert.equal(added.length, 2, 'returns only what it added');
  assert.deepEqual(doc.sentences, [
    'Long Book',
    'The opening paragraph sits here.',
    'A later paragraph arrives.',
    'It has two sentences.',
    'Chapter Two'
  ]);
  // Every sentence must still be findable by its own index.
  const flat = doc.blocks.flatMap((b) => b.sentences);
  for (const { text, index } of flat) assert.equal(doc.sentences[index], text, `index ${index} must match`);
  assert.deepEqual(flat.map((x) => x.index), flat.map((_, i) => i), 'indices run 0..n with no gaps');
});

test('appendBlocks extends blockStarts so handover still lands on a paragraph', () => {
  const doc = buildModel({ blocks: [{ kind: 'text', text: 'First paragraph here.' }] });
  assert.deepEqual(doc.blockStarts, [0]);
  appendBlocks(doc, [{ kind: 'text', text: 'Second paragraph here.' }], 'en');
  appendBlocks(doc, [{ kind: 'text', text: 'Third paragraph here.' }], 'en');
  assert.deepEqual(doc.blockStarts, [0, 1, 2]);
});

test('appendBlocks ignores blocks with no text', () => {
  const doc = buildModel({ blocks: [{ kind: 'text', text: 'Something to read here.' }] });
  const before = doc.sentences.length;
  assert.equal(appendBlocks(doc, [{ kind: 'text', text: '   ' }, { kind: 'text', text: '' }], 'en').length, 0);
  assert.equal(doc.sentences.length, before);
});

test('appending to an empty document behaves like building one', () => {
  const doc = buildModel({});
  appendBlocks(doc, [{ kind: 'text', text: 'The only paragraph here.' }], 'en');
  assert.deepEqual(doc.sentences, ['The only paragraph here.']);
  assert.deepEqual(doc.blockStarts, [0]);
});

// ---------------------------------------------------------------- pdf layout

/** Build a page of text runs: one line per entry, laid out top to bottom. */
const page = (lines, { h = 10, lead = 14, top = 700, left = 50, charW = 5 } = {}) =>
  lines.map((text, i) => ({
    str: text,
    x: left + (typeof text === 'object' ? text.indent || 0 : 0),
    y: top - i * lead,
    w: String(text).length * charW,
    h
  }));

test('linesOf groups runs on the same baseline, left to right', () => {
  const items = [
    { str: 'world', x: 80, y: 700, w: 25, h: 10 },
    { str: 'Hello', x: 50, y: 700, w: 25, h: 10 },
    { str: 'Next', x: 50, y: 686, w: 20, h: 10 }
  ];
  const lines = linesOf(items, 0);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Hello world');
  assert.equal(lines[1].text, 'Next');
});

test('one wrapped paragraph becomes one block', () => {
  const blocks = blocksFromPages([page([
    'The committee met on Tuesday to consider the report that had',
    'been circulated the previous week, and after some discussion',
    'agreed to publish it in full.'
  ])]);
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].text.startsWith('The committee met'));
  assert.ok(blocks[0].text.endsWith('in full.'));
});

test('a wide vertical gap starts a new paragraph', () => {
  const first = page(['The first paragraph runs to about here and then', 'finishes on this line.'], { top: 700 });
  const second = page(['The second paragraph begins well below the first', 'and continues here.'], { top: 640 });
  const blocks = blocksFromPages([[...first, ...second]]);
  assert.equal(blocks.length, 2);
});

test('end-of-line hyphenation is undone when joining', () => {
  assert.equal(join('respon-', 'sibility follows'), 'responsibility follows');
  assert.equal(join('the end-', 'Capitalised'), 'the end- Capitalised', 'not a hyphenated word break');
  assert.equal(join('plain', 'continuation'), 'plain continuation');
});

test('a larger, short line is treated as a heading', () => {
  const heading = [{ str: 'Chapter One', x: 50, y: 700, w: 60, h: 16 }];
  const body = page(['The body text of the chapter begins here and runs on', 'for a second line.'], { top: 670 });
  const blocks = blocksFromPages([[...heading, ...body]]);
  assert.equal(blocks[0].kind, 'heading');
  assert.equal(blocks[0].text, 'Chapter One');
  assert.equal(blocks[1].kind, 'text');
});

test('page numbers are dropped', () => {
  for (const t of ['7', 'Page 12', 'iv', '[3]']) assert.ok(isPageNumber(t), `should be a page number: ${t}`);
  assert.ok(!isPageNumber('1066 was a notable year'));
});

test('a running header repeated across pages is dropped', () => {
  const words = ['alpha discussion of the matter', 'beta findings of the review', 'gamma summary of the case', 'delta appendix of the notes'];
  const body = (n) => page([`The ${words[n - 1]} continues here at length`, 'and finishes on this line.'], { top: 660 });
  const header = [{ str: 'A Very Official Report', x: 50, y: 740, w: 100, h: 10 }];
  const pages = [1, 2, 3, 4].map((n) => [...header, ...body(n)]);
  const blocks = blocksFromPages(pages);
  assert.ok(!blocks.some((b) => b.text.includes('Very Official Report')), 'header should be gone');
  assert.ok(blocks.some((b) => b.text.includes('alpha discussion')), 'body must survive');
});

test('body paragraphs that differ only by a number are not mistaken for furniture', () => {
  // norm() turns digits into '#', so these look identical to the repeat detector. Only the
  // margin test keeps them: prose sits in the middle of the page, furniture at the edges.
  const header = [{ str: 'Running Head', x: 50, y: 745, w: 60, h: 10 }];
  const pages = [1, 2, 3, 4].map((n) => [
    ...header,
    ...page([`Table ${n} shows the measured result for this run`, 'across every sample taken.'], { top: 500 }),
    ...page([`Footer note ${n}`], { top: 40 })
  ]);
  const blocks = blocksFromPages(pages);
  assert.ok(blocks.some((b) => b.text.includes('shows the measured result')), 'repeated-shape prose must survive');
  assert.ok(!blocks.some((b) => b.text.includes('Running Head')), 'header still dropped');
  assert.ok(!blocks.some((b) => b.text.includes('Footer note')), 'footer still dropped');
});

test('a header appearing on only two pages is kept, since it may be prose', () => {
  const header = [{ str: 'Unique line here', x: 50, y: 740, w: 80, h: 10 }];
  const pages = [1, 2].map((n) => [...header, ...page([`Body ${n} runs here.`], { top: 660 })]);
  assert.ok(blocksFromPages(pages).some((b) => b.text.includes('Unique line here')));
});

test('a paragraph continues across a page break mid-sentence', () => {
  const p1 = page(['The argument begins on the first page and does not'], { top: 700 });
  const p2 = page(['finish until the second page is well under way.'], { top: 700 });
  const blocks = blocksFromPages([p1, p2]);
  assert.equal(blocks.length, 1, 'should read as one sentence across the break');
  assert.ok(blocks[0].text.includes('does not finish until'));
});

test('an empty or textless PDF yields no blocks', () => {
  assert.deepEqual(blocksFromPages([]), []);
  assert.deepEqual(blocksFromPages([[], [{ str: '   ', x: 0, y: 0, w: 0, h: 0 }]]), []);
});

test('a PDF feeds the same model the web reader uses', () => {
  const blocks = blocksFromPages([page(['A sentence from a PDF. And a second one.'])]);
  const doc = buildModel({ title: 'report', site: 'PDF', blocks });
  assert.deepEqual(doc.sentences, ['report', 'A sentence from a PDF.', 'And a second one.']);
  assert.deepEqual(doc.blockStarts, [0, 1]);
});

// ---------------------------------------------------------------- tab mark

test('markedTitle prefixes a glyph only while there is something to show', () => {
  assert.equal(markedTitle('An Article', 'playing'), '\u25B6 An Article');
  assert.equal(markedTitle('An Article', 'paused'), '\u23F8 An Article');
  assert.equal(markedTitle('An Article', 'buffering'), '\u25B6 An Article');
});

test('markedTitle leaves the title alone when reading has stopped', () => {
  for (const state of ['idle', 'ended', 'error', undefined]) {
    assert.equal(markedTitle('An Article', state), 'An Article', `state ${state} should not mark`);
  }
});

test('markedTitle does not stack glyphs when called twice', () => {
  const once = markedTitle('An Article', 'playing');
  // set() always marks the remembered original, never the current title.
  assert.equal(markedTitle('An Article', 'playing'), once);
  assert.ok(!markedTitle('An Article', 'playing').startsWith('\u25B6 \u25B6'));
});

test('the tab icon is a self-contained data URI', () => {
  assert.ok(ICON.startsWith('data:image/svg+xml,'), 'must not fetch anything');
  assert.ok(!/https?:/.test(ICON));
});

test('strip removes our glyph so a title is never marked twice', () => {
  assert.equal(strip('\u25B6 An Article'), 'An Article');
  assert.equal(strip('\u23F8 An Article'), 'An Article');
  assert.equal(strip('An Article'), 'An Article');
  // Round-tripping is what keeps an SPA's title changes clean.
  assert.equal(markedTitle(strip(markedTitle('An Article', 'playing')), 'playing'), '\u25B6 An Article');
});
