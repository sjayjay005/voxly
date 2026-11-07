// The content script's entry point: toggle the reader on the current page.
// Everything else — the view, the Port, reconnection, the word clock — lives in
// src/doc/session.js, which the PDF and EPUB reader shares.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.reader) return;

  let session = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'voxly:toggle') session ? close() : open();
  });

  function open() {
    const doc = VX.extract();
    // Nothing to read. No reader is on screen yet, so let the service worker badge the toolbar
    // icon instead of interrupting the page with a dialog.
    if (!doc.sentences.length) { chrome.runtime.sendMessage({ type: 'voxly:unreadable' }).catch(() => {}); return; }
    session = VX.createSession(doc, { onClosed: () => { session = null; } });
  }

  function close() {
    session?.close();
    session = null;
  }

  VX.reader = { open, close };
})();
