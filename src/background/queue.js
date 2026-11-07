// The listen-later queue.
//
// Each entry carries the extracted sentences, not a URL. Fetching a page later would need
// permission to read every site you visit, which Voxly does not ask for and will not — so the
// text is captured at the moment you add it, while activeTab still grants access to that one
// page. The cost is that an entry is a snapshot: re-add a page to pick up changes.
//
// chrome.storage.local, because the queue holds whole articles and sync storage allows 100 KB.
const KEY = 'voxly.queue';
const MAX_ITEMS = 50;
const MAX_CHARS = 400_000; // one very long book's worth, well inside unlimitedStorage

/** Drop the oldest entries until the queue is within both caps. Exported for tests. */
export function trim(items, { maxItems = MAX_ITEMS, maxChars = MAX_CHARS } = {}) {
  const kept = [];
  let chars = 0;
  // Newest first, so what gets dropped is what has waited longest.
  for (const item of [...items].sort((a, b) => b.addedAt - a.addedAt)) {
    const size = item.sentences.reduce((n, s) => n + s.length, 0);
    if (kept.length >= maxItems) break;
    if (chars + size > maxChars && kept.length) break;
    chars += size;
    kept.push(item);
  }
  return kept;
}

/** An entry from an extracted document. Exported for tests. */
export function entryFrom(doc, url) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: doc.title || doc.site || 'Untitled',
    site: doc.site || '',
    url: url || '',
    sentences: doc.sentences,
    blockStarts: doc.blockStarts || [],
    addedAt: Date.now()
  };
}

export async function list() {
  const got = await chrome.storage.local.get(KEY);
  return Array.isArray(got[KEY]) ? got[KEY] : [];
}

const save = (items) => chrome.storage.local.set({ [KEY]: items });

/** Add a document. A page already queued is replaced rather than duplicated. */
export async function add(doc, url) {
  const entry = entryFrom(doc, url);
  const items = (await list()).filter((i) => !i.url || i.url !== entry.url);
  await save(trim([entry, ...items]));
  return entry;
}

export async function remove(id) {
  await save((await list()).filter((i) => i.id !== id));
}

export async function clear() {
  await chrome.storage.local.remove(KEY);
}

export async function get(id) {
  return (await list()).find((i) => i.id === id) || null;
}

/** What the panel needs to draw the list: no sentences, which would be megabytes. */
export const summarise = (items) => items.map(({ id, title, site, addedAt, sentences }) => ({
  id, title, site, addedAt, count: sentences.length
}));
