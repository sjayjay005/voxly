// The listen-later queue's caps and entry shape.
//
// An entry holds a whole article's sentences, so the caps are what stop the queue growing without
// limit, and what gets dropped when it is full has to be the thing that has waited longest — not
// whatever happens to be first in the array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trim, entryFrom, summarise } from '../src/background/queue.js';

const item = (id, { sentences = 1, chars = 100, addedAt = id } = {}) => ({
  id: String(id),
  title: `Article ${id}`,
  site: 'example.com',
  url: `https://example.com/${id}`,
  sentences: Array.from({ length: sentences }, () => 'x'.repeat(chars)),
  blockStarts: [0],
  addedAt
});

test('trim keeps the newest entries when there are too many', () => {
  const kept = trim([item(1), item(2), item(3), item(4)], { maxItems: 2 });
  assert.deepEqual(kept.map((i) => i.id), ['4', '3']);
});

test('trim orders by when things were added, not by array position', () => {
  // The caller prepends, but a queue read back from storage could be in any order.
  const kept = trim([item(1, { addedAt: 10 }), item(2, { addedAt: 30 }), item(3, { addedAt: 20 })], { maxItems: 2 });
  assert.deepEqual(kept.map((i) => i.id), ['2', '3']);
});

test('trim stops once the character budget is spent', () => {
  const kept = trim([item(1, { sentences: 50 }), item(2, { sentences: 50 }), item(3, { sentences: 50 })], { maxChars: 12_000 });
  assert.equal(kept.length, 2, '5000 chars each against a 12000 budget');
  assert.deepEqual(kept.map((i) => i.id), ['3', '2']);
});

test('a single entry larger than the whole budget is still kept', () => {
  // Refusing it would mean a long book could never be queued at all.
  const kept = trim([item(1, { sentences: 1000 })], { maxChars: 10 });
  assert.equal(kept.length, 1);
});

test('trim handles an empty queue', () => {
  assert.deepEqual(trim([]), []);
});

test('entryFrom takes what the panel and playback both need', () => {
  const doc = { title: 'A Title', site: 'example.com', sentences: ['One.', 'Two.'], blockStarts: [0] };
  const e = entryFrom(doc, 'https://example.com/a');
  assert.equal(e.title, 'A Title');
  assert.equal(e.url, 'https://example.com/a');
  assert.deepEqual(e.sentences, ['One.', 'Two.']);
  assert.deepEqual(e.blockStarts, [0]);
  assert.ok(e.addedAt > 0);
  assert.ok(e.id, 'needs an id to be removable');
});

test('entryFrom falls back to the site, then to Untitled', () => {
  assert.equal(entryFrom({ site: 'example.com', sentences: ['x'] }).title, 'example.com');
  assert.equal(entryFrom({ sentences: ['x'] }).title, 'Untitled');
});

test('entry ids are distinct even for two added in the same millisecond', () => {
  const doc = { title: 'A', sentences: ['x'] };
  const ids = new Set(Array.from({ length: 200 }, () => entryFrom(doc).id));
  assert.equal(ids.size, 200);
});

test('summarise leaves the sentences behind', () => {
  // The panel renders a list; sending it every article's text would be megabytes per redraw.
  const [s] = summarise([item(1, { sentences: 3 })]);
  assert.deepEqual(Object.keys(s).sort(), ['addedAt', 'count', 'id', 'site', 'title']);
  assert.equal(s.count, 3);
});
