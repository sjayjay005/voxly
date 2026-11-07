// Showing, in the browser's tab strip, which tab is reading.
//
// Chrome's own speaker icon never appears for Voxly: the audio comes from the offscreen document
// or from chrome.tts, not from the tab, so a tab that is reading looks exactly like one that is
// not. Once you switch away to another tab there is nothing to tell you where the voice is
// coming from.
//
// The tab strip only shows two things a page can change — its title and its favicon — so we
// borrow both while reading and put them back afterwards. The title is the reliable one; a
// favicon set from a data: URI can be refused by a strict page CSP, so it is best-effort.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.tabMark) return;

  const GLYPH = { playing: '\u25B6', paused: '\u23F8', buffering: '\u25B6' };

  /** The title this tab should show. Exported for tests. */
  function markedTitle(original, state) {
    const glyph = GLYPH[state];
    return glyph ? `${glyph} ${original}` : original;
  }

  // A play mark in Voxly's brand purple, legible at 16px.
  const ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + '<rect width="32" height="32" rx="8" fill="#5B3DF5"/>'
    + '<path d="M12 9.5v13c0 .8.9 1.3 1.6.8l9.2-6.5c.6-.4.6-1.3 0-1.7l-9.2-6.4c-.7-.5-1.6 0-1.6.8z" fill="#fff"/>'
    + '</svg>');

  const GLYPHS = Object.values(GLYPH);
  const isOurs = (title) => GLYPHS.some((g) => title.startsWith(g + ' '));
  const strip = (title) => (isOurs(title) ? title.slice(2) : title);

  let original = null;   // the page's own title, without our mark
  let wanted = null;     // the title we are imposing, if any
  let state = null;      // the reading state the mark reflects
  let icons = null;      // the page's own icon links, detached while we borrow the slot
  let ours = null;
  let observer = null;

  function writeTitle(text) {
    wanted = text;
    if (document.title !== text) document.title = text;
  }

  /**
   * A single-page app rewrites its own title as you navigate. Re-mark whatever it set rather than
   * forcing the old one back, so the tab still shows the page it is on — just with our glyph.
   */
  function watchTitle() {
    if (observer) return;
    const target = document.querySelector('title') || document.head;
    if (!target) return;
    observer = new MutationObserver(() => {
      if (!wanted) return;
      const now = document.title;
      if (now === wanted) return;        // our own write coming back round
      original = strip(now);             // the page had something new to say
      writeTitle(markedTitle(original, state));
    });
    observer.observe(target, { childList: true, characterData: true, subtree: true });
  }

  function borrowIcon() {
    if (icons || !document.head) return;
    try {
      icons = [...document.querySelectorAll('link[rel~="icon"]')];
      for (const l of icons) l.remove();
      ours = document.createElement('link');
      ours.rel = 'icon';
      ours.href = ICON;
      document.head.append(ours);
    } catch { icons = icons || []; }
  }

  function returnIcon() {
    try {
      ours?.remove();
      for (const l of icons || []) document.head?.append(l);
    } catch {}
    ours = null;
    icons = null;
  }

  /** Reflect a reading state in the tab strip. Any state without a glyph clears the mark. */
  function set(next) {
    if (original == null) original = strip(document.title);
    state = next;
    const title = markedTitle(original, next);
    if (title === original) return restore();
    watchTitle();
    writeTitle(title);
    borrowIcon();
  }

  /** Give the tab its own title and icon back. */
  function restore() {
    observer?.disconnect();
    observer = null;
    wanted = null;
    state = null;
    if (original != null && document.title !== original) document.title = original;
    returnIcon();
  }

  VX.tabMark = { set, restore, markedTitle, strip, ICON };
})();
