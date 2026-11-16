// A snapshot of what the page is actually showing, as an inert document for Readability.
//
// document.cloneNode(true) copies the raw DOM, which goes wrong on app-like sites such as LMSs and
// web-component UIs (Brightspace/D2L, for example):
//   - hidden elements come along — a closed "Are you still there?" timeout dialog gets read aloud;
//   - shadow-DOM content is left behind — web components render their text in shadow roots;
//   - iframe content is left behind — lesson/topic bodies often live in a same-origin iframe.
// This walks the live, rendered tree instead: it keeps only visible elements, flattens open shadow
// roots (honouring <slot>s), and inlines same-origin iframes. Cross-origin frames can't be read from
// here, so they're reported back for the caller to explain.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.snapshot) return;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED',
    'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON', 'VOXLY-READER']);
  const MAX_NODES = 60_000;  // a ceiling so a pathological page can't stall the tab
  const MIN_FRAME_AREA = 200 * 150;

  function visible(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true' || el.inert) return false;
    if (el.tagName === 'DIALOG' && !el.open) return false;
    // checkVisibility accounts for display:none, content-visibility and visibility:hidden up the tree.
    if (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return true;
    // display:contents wrappers have no box of their own, so they "fail" the check while their children show.
    return getComputedStyle(el).display === 'contents';
  }

  VX.snapshot = function snapshot(rootDoc = document) {
    const out = document.implementation.createHTMLDocument(rootDoc.title); // no custom-element registry: nothing upgrades or runs
    const crossOrigin = [];
    let budget = MAX_NODES;

    // Children to visit for an element, as it renders: its shadow tree if it has one (light DOM appears via slots).
    const childrenOf = (el) => (el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes);

    function copy(node, into) {
      if (--budget < 0) return;
      if (node.nodeType === Node.TEXT_NODE) { into.append(out.createTextNode(node.data)); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag)) return;

      if (tag === 'SLOT') { // inside a shadow tree: render what's slotted in (or the fallback)
        const assigned = el.assignedNodes({ flatten: true });
        for (const n of assigned.length ? assigned : el.childNodes) copy(n, into);
        return;
      }
      if (!visible(el)) return;

      if (tag === 'IFRAME' || tag === 'FRAME') {
        const r = el.getBoundingClientRect();
        if (r.width * r.height < MIN_FRAME_AREA) return; // ads, trackers, widgets
        let doc = null;
        try { doc = el.contentDocument; } catch {}
        if (doc?.body) {
          const box = out.createElement('div');
          box.setAttribute('data-voxly-frame', '');
          into.append(box);
          for (const n of doc.body.childNodes) copy(n, box);
        } else {
          try { crossOrigin.push({ src: new URL(el.src, location.href).href, area: r.width * r.height }); } catch {}
        }
        return;
      }

      // Unknown custom elements become plain <div>s so Readability treats them as containers.
      const name = tag.includes('-') ? 'div' : el.localName;
      const c = out.createElement(name);
      for (const a of ['id', 'class', 'role', 'lang', 'dir', 'href', 'itemprop']) {
        const v = el.getAttribute(a);
        if (v != null) c.setAttribute(a, v);
      }
      into.append(c);
      for (const n of childrenOf(el)) copy(n, c);
    }

    for (const n of childrenOf(rootDoc.body || rootDoc.documentElement)) copy(n, out.body);
    out.documentElement.lang = rootDoc.documentElement.lang || '';
    crossOrigin.sort((a, b) => b.area - a.area);
    return { doc: out, crossOrigin, truncated: budget < 0 };
  };
})();
