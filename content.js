// Voxly content script: text extraction with a DOM map, in-page highlighting, and the floating player.
(() => {
  if (window.__voxlyLoaded) return;
  window.__voxlyLoaded = true;

  // ------------------------------------------------------------------
  // Extraction. We build the spoken text ourselves and remember, for every
  // character, which DOM text node it came from — so we can highlight the
  // word being spoken right on the page.
  // ------------------------------------------------------------------
  const BLOCK = 'p,div,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,pre,section,article,dt,dd,figcaption,header,tr,main';
  const SKIP = 'script,style,noscript,template,svg,canvas,nav,aside,footer,button,select,textarea,input,label,[aria-hidden="true"],[hidden],voxly-player,sup';
  let map = null; // { nodes: Node[], offs: number[] } aligned with the spoken text

  function collect(root, range) {
    let out = '';
    const nodes = [], offs = [];
    const vis = new Map();
    const visible = (el) => {
      if (!vis.has(el)) vis.set(el, el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!el.offsetParent);
      return vis.get(el);
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (range && !range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        const el = n.parentElement;
        if (!el || el.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        if (!range && !visible(el)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let lastBlock = null;
    const add = (ch, node, off) => { out += ch; nodes.push(node); offs.push(off); };
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      let s = 0, e = n.data.length;
      if (range && n === range.startContainer) s = range.startOffset;
      if (range && n === range.endContainer) e = range.endOffset;
      const blk = n.parentElement.closest(BLOCK);
      if (out && blk !== lastBlock && !/^\s*$/.test(n.data.slice(s, e))) {
        // New paragraph/heading/list item: make sure the voice pauses between them.
        if (out.endsWith(' ')) { out = out.slice(0, -1); nodes.pop(); offs.pop(); }
        if (!/[.!?:;,…"')\]]$/.test(out)) add('.', null, 0);
        add(' ', null, 0);
      }
      if (!/^\s*$/.test(n.data.slice(s, e))) lastBlock = blk;
      for (let i = s; i < e; i++) {
        const c = n.data[i];
        if (/\s/.test(c)) { if (out && !out.endsWith(' ')) add(' ', n, i); }
        else add(c, n, i);
      }
    }
    if (out.endsWith(' ')) { out = out.slice(0, -1); nodes.pop(); offs.pop(); }
    return { text: out, nodes, offs };
  }

  // Find the element that holds the article: <article>/<main> if they're real, else the densest cluster of <p>.
  function pickRoot() {
    for (const sel of ['article', 'main', '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 600) return el;
    }
    const score = new Map();
    for (const p of document.querySelectorAll('p')) {
      const len = p.innerText.trim().length;
      if (len < 40 || !p.parentElement) continue;
      score.set(p.parentElement, (score.get(p.parentElement) || 0) + len);
    }
    let best = null, bestScore = 0;
    for (const [el, sc] of score) if (sc > bestScore) { best = el; bestScore = sc; }
    return bestScore > 400 ? best : document.body;
  }

  function extract(mode) {
    const sel = window.getSelection();
    const hasSel = sel && sel.rangeCount && String(sel).trim().length > 0;
    if (mode !== 'page' && hasSel) {
      const range = sel.getRangeAt(0);
      let root = range.commonAncestorContainer;
      if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
      const r = collect(root, range);
      if (r.text.trim()) { map = r; return { text: r.text, title: document.title }; }
    }
    if (mode === 'selection') return { text: '', title: document.title };
    const r = collect(pickRoot(), null);
    if (r.text.length > 200) { map = r; return { text: r.text, title: document.title }; }
    // Last resort: Readability's plain text (no on-page highlighting for this one).
    map = null;
    try {
      const a = new Readability(document.cloneNode(true)).parse();
      if (a?.textContent?.trim()) return { text: (a.title ? a.title + '. ' : '') + a.textContent, title: document.title };
    } catch {}
    return { text: document.body?.innerText || '', title: document.title };
  }

  // ------------------------------------------------------------------
  // In-page highlighting via the CSS Custom Highlight API (no DOM changes).
  // ------------------------------------------------------------------
  const canHighlight = typeof Highlight !== 'undefined' && CSS.highlights;
  let pageStyle = null, follow = true, userScrolledAt = 0, lastScroll = 0;
  addEventListener('wheel', () => { userScrolledAt = Date.now(); }, { passive: true });
  addEventListener('touchmove', () => { userScrolledAt = Date.now(); }, { passive: true });

  function ensurePageStyle() {
    if (pageStyle || !canHighlight) return;
    pageStyle = document.createElement('style');
    pageStyle.textContent = `
      ::highlight(voxly-sentence) { background-color: rgba(139,108,255,.16); }
      ::highlight(voxly-word) { background-color: rgba(139,108,255,.55); color: inherit; }`;
    (document.head || document.documentElement).appendChild(pageStyle);
  }

  function rangeFor(start, len) {
    if (!map) return null;
    let a = start, b = start + len - 1;
    while (a <= b && !map.nodes[a]) a++;
    while (b >= a && !map.nodes[b]) b--;
    if (a > b || !map.nodes[a]) return null;
    try {
      const r = document.createRange();
      r.setStart(map.nodes[a], map.offs[a]);
      r.setEnd(map.nodes[b], map.offs[b] + 1);
      return r;
    } catch { return null; }
  }

  function highlightSentence(i) {
    if (!canHighlight || !map) return;
    ensurePageStyle();
    const r = rangeFor(starts[i], chunks[i].length);
    if (r) CSS.highlights.set('voxly-sentence', new Highlight(r)); else CSS.highlights.delete('voxly-sentence');
    if (r) maybeScroll(r);
  }

  function highlightWord(i, charIndex, length) {
    if (!canHighlight || !map) return;
    const r = rangeFor(starts[i] + charIndex, length);
    if (!r) return;
    CSS.highlights.set('voxly-word', new Highlight(r));
    maybeScroll(r);
  }

  function maybeScroll(r) {
    if (!follow || Date.now() - userScrolledAt < 4000 || Date.now() - lastScroll < 500) return;
    const rect = r.getBoundingClientRect();
    if (!rect.height) return;
    if (rect.top < 80 || rect.bottom > innerHeight - 200) {
      lastScroll = Date.now();
      scrollBy({ top: rect.top - innerHeight * 0.35, behavior: 'smooth' });
    }
  }

  function clearHighlights() {
    if (!canHighlight) return;
    CSS.highlights.delete('voxly-word');
    CSS.highlights.delete('voxly-sentence');
  }

  // ------------------------------------------------------------------
  // Floating player
  // ------------------------------------------------------------------
  const SPEEDS = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5];
  const I = {
    play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/>',
    prev: '<path d="M7 6h2v12H7zM19 6.8v10.4a.8.8 0 0 1-1.25.66L10.5 12.7a.8.8 0 0 1 0-1.4l7.25-5.16A.8.8 0 0 1 19 6.8z"/>',
    next: '<path d="M15 6h2v12h-2zM5 6.8v10.4a.8.8 0 0 0 1.25.66l7.25-5.16a.8.8 0 0 0 0-1.4L6.25 6.14A.8.8 0 0 0 5 6.8z"/>',
    close: '<path d="M7.05 5.64 12 10.59l4.95-4.95 1.41 1.41L13.41 12l4.95 4.95-1.41 1.41L12 13.41l-4.95 4.95-1.41-1.41L10.59 12 5.64 7.05z"/>',
    mini: '<path d="M6 11h12v2H6z"/>',
    expand: '<path d="M5 5h6v2H7v4H5zm14 14h-6v-2h4v-4h2z"/>',
    follow: '<path d="M12 4a1 1 0 0 1 1 1v9.59l3.3-3.3 1.4 1.42L12 18.4l-5.7-5.7 1.4-1.4 3.3 3.29V5a1 1 0 0 1 1-1z"/>'
  };
  const svg = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true">${p}</svg>`;

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .p { position: fixed; right: 22px; bottom: 22px; width: 380px; max-width: calc(100vw - 32px);
         color: #ece9f6; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         background: rgba(20,17,30,.92); backdrop-filter: blur(18px) saturate(1.4);
         border: 1px solid rgba(255,255,255,.08); border-radius: 18px;
         box-shadow: 0 18px 50px -12px rgba(10,5,30,.55), 0 0 0 1px rgba(0,0,0,.2);
         transform-origin: bottom right; animation: enter .38s cubic-bezier(.2,.9,.25,1.15) both;
         transition: width .35s cubic-bezier(.3,.9,.3,1), border-radius .35s; overflow: hidden; }
    .p.leaving { animation: leave .22s ease-in both; }
    @keyframes enter { from { opacity: 0; transform: translateY(18px) scale(.94); } }
    @keyframes leave { to { opacity: 0; transform: translateY(12px) scale(.96); } }

    /* header */
    .head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; cursor: grab; user-select: none; }
    .head:active { cursor: grabbing; }
    .eq { display: flex; align-items: flex-end; gap: 2.5px; width: 20px; height: 18px; flex: none; }
    .eq i { flex: 1; height: 100%; border-radius: 2px; background: linear-gradient(#b7a4ff, #6d4aff);
            transform-origin: bottom; transform: scaleY(.25); transition: transform .3s; }
    .p[data-state="playing"] .eq i { animation: eq 1s ease-in-out infinite; }
    .eq i:nth-child(2) { animation-delay: -.45s !important; } .eq i:nth-child(3) { animation-delay: -.2s !important; } .eq i:nth-child(4) { animation-delay: -.7s !important; }
    @keyframes eq { 0%,100% { transform: scaleY(.25); } 30% { transform: scaleY(1); } 60% { transform: scaleY(.5); } 80% { transform: scaleY(.8); } }
    .p[data-state="loading"] .eq i { animation: wave 1.1s ease-in-out infinite; opacity: .7; }
    @keyframes wave { 0%,100% { transform: scaleY(.2); } 50% { transform: scaleY(.6); } }
    .meta { flex: 1; min-width: 0; }
    .title { font-weight: 650; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -.01em; }
    .sub { font-size: 11.5px; color: #9d97b5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub b { font-weight: 600; color: #c4b8ff; }

    button { all: unset; cursor: pointer; display: grid; place-items: center; color: #ece9f6; border-radius: 10px;
             transition: background .15s, transform .12s, color .15s, opacity .2s; -webkit-tap-highlight-color: transparent; }
    button:active { transform: scale(.92); }
    button svg { width: 20px; height: 20px; fill: currentColor; }
    .icon { width: 30px; height: 30px; color: #9d97b5; } .icon:hover { background: rgba(255,255,255,.07); color: #fff; }
    .icon svg { width: 18px; height: 18px; }
    .miniplay { display: none; width: 34px; height: 34px; border-radius: 50%; background: #6d4aff; }

    /* body */
    .body { padding: 0 16px 14px; transition: opacity .25s, max-height .35s cubic-bezier(.3,.9,.3,1); max-height: 400px; }
    .stage { position: relative; }
    .text { max-height: 126px; overflow: auto; font-size: 15px; line-height: 1.6; color: #d9d4ea; scrollbar-width: thin; }
    .text.swap { animation: swap .35s cubic-bezier(.2,.8,.2,1); }
    @keyframes swap { from { opacity: 0; transform: translateY(8px); filter: blur(2px); } }
    mark { background: linear-gradient(135deg, #8b6cff, #6d4aff); color: #fff; border-radius: 5px; padding: 1px 3px; margin: 0 -1px;
           box-shadow: 0 2px 10px -2px rgba(109,74,255,.7); animation: pop .18s ease-out; }
    @keyframes pop { from { transform: scale(.85); opacity: .5; } }
    .skeleton { display: none; flex-direction: column; gap: 9px; padding: 4px 0 6px; }
    .skeleton span { height: 11px; border-radius: 6px; background: linear-gradient(90deg, #2a2440 0%, #40375f 40%, #2a2440 80%);
                     background-size: 300% 100%; animation: shimmer 1.4s linear infinite; }
    .skeleton span:nth-child(2) { width: 88%; } .skeleton span:nth-child(3) { width: 62%; }
    @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -50% 0; } }
    .p[data-state="loading"] .skeleton { display: flex; }
    .p[data-state="loading"] .text { display: none; }
    .status { font-size: 12px; color: #b9a8ff; margin-top: 6px; display: none; }
    .status::after { content: ''; animation: dots 1.2s steps(4) infinite; }
    @keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
    .p[data-state="loading"] .status { display: block; }
    .err { font-size: 12px; color: #ff9b9b; margin-top: 6px; display: none; animation: swap .3s; }

    .track { position: relative; height: 16px; margin: 12px 0 2px; cursor: pointer; }
    .track::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 4px; border-radius: 4px; background: rgba(255,255,255,.08); }
    .fill { position: absolute; left: 0; top: 6px; height: 4px; border-radius: 4px; width: 0;
            background: linear-gradient(90deg, #6d4aff, #b7a4ff); transition: width .45s cubic-bezier(.3,.9,.3,1); }
    .knob { position: absolute; top: 3px; width: 10px; height: 10px; border-radius: 50%; background: #fff; margin-left: -5px; left: 0;
            box-shadow: 0 0 0 4px rgba(139,108,255,.25), 0 0 14px rgba(139,108,255,.8); transition: left .45s cubic-bezier(.3,.9,.3,1), transform .15s; }
    .track:hover .knob { transform: scale(1.3); }
    .hover-tip { position: absolute; top: -22px; transform: translateX(-50%); font-size: 11px; padding: 2px 6px; border-radius: 6px;
                 background: #2a2440; color: #fff; pointer-events: none; opacity: 0; transition: opacity .15s; white-space: nowrap; }
    .track:hover .hover-tip { opacity: 1; }
    .times { display: flex; justify-content: space-between; font-size: 11.5px; color: #8a84a3; font-variant-numeric: tabular-nums; }

    .ctl { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
    .mid { display: flex; align-items: center; gap: 8px; }
    .skip { width: 38px; height: 38px; border-radius: 50%; color: #cfc8e8; } .skip:hover { background: rgba(255,255,255,.08); color: #fff; }
    .play { position: relative; width: 52px; height: 52px; border-radius: 50%;
            background: radial-gradient(circle at 30% 25%, #9b80ff, #6d4aff 60%, #5634e8);
            box-shadow: 0 8px 24px -6px rgba(109,74,255,.8), inset 0 1px 0 rgba(255,255,255,.25); }
    .play:hover { transform: translateY(-1px); box-shadow: 0 12px 28px -6px rgba(109,74,255,.95), inset 0 1px 0 rgba(255,255,255,.25); }
    .play svg { position: absolute; width: 24px; height: 24px; transition: transform .25s cubic-bezier(.3,1.4,.4,1), opacity .2s; }
    .play .i-play { opacity: 0; transform: scale(.4) rotate(-90deg); }
    .p[data-state="paused"] .play .i-play, .p[data-state="paused"] .miniplay .i-play { opacity: 1; transform: none; }
    .p[data-state="paused"] .play .i-pause, .p[data-state="paused"] .miniplay .i-pause { opacity: 0; transform: scale(.4) rotate(90deg); }
    .play::after { content: ''; position: absolute; inset: -5px; border-radius: 50%; border: 2px solid transparent;
                   border-top-color: #b7a4ff; opacity: 0; transition: opacity .2s; }
    .p[data-state="loading"] .play::after { opacity: 1; animation: spin .9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .p[data-state="playing"] .play { animation: breathe 2.4s ease-in-out infinite; }
    @keyframes breathe { 50% { box-shadow: 0 8px 30px -4px rgba(139,108,255,.95), inset 0 1px 0 rgba(255,255,255,.25); } }
    .miniplay { position: relative; } .miniplay svg { position: absolute; width: 18px; height: 18px; transition: transform .25s, opacity .2s; }
    .miniplay .i-play { opacity: 0; transform: scale(.4); }

    .chip { height: 30px; min-width: 54px; padding: 0 10px; border-radius: 15px; font-size: 12.5px; font-weight: 650;
            background: rgba(255,255,255,.06); color: #ddd6ff; font-variant-numeric: tabular-nums; }
    .chip:hover { background: rgba(255,255,255,.11); }
    .chip.bump { animation: bump .3s; } @keyframes bump { 40% { transform: scale(1.12); background: rgba(139,108,255,.35); } }
    .chip.toggle { display: flex; gap: 5px; align-items: center; color: #8a84a3; }
    .chip.toggle svg { width: 14px; height: 14px; }
    .chip.toggle.on { color: #ddd6ff; background: rgba(139,108,255,.2); }

    /* minimized */
    .p.mini { width: 300px; border-radius: 28px; }
    .p.mini .body { max-height: 0; opacity: 0; padding-bottom: 0; pointer-events: none; }
    .p.mini .head { padding: 8px 8px 8px 16px; }
    .p.mini .miniplay { display: grid; }
    .p.mini .bar-mini { opacity: 1; }
    .bar-mini { position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: linear-gradient(90deg, #6d4aff, #b7a4ff);
                opacity: 0; transition: width .45s, opacity .3s; }

    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `;

  let host = null, ui = {}, chunks = [], starts = [], words = [], current = 0, rate = 1, state = 'loading';

  function build({ title, voice, engine }) {
    if (host) host.remove();
    host = document.createElement('voxly-player');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS_TEXT}</style>
      <div class="p" data-state="loading" role="region" aria-label="Voxly reader">
        <div class="head">
          <div class="eq"><i></i><i></i><i></i><i></i></div>
          <div class="meta"><div class="title"></div><div class="sub"></div></div>
          <button class="miniplay" data-a="toggle" title="Play / pause">${svg(I.pause).replace('<svg', '<svg class="i-pause"')}${svg(I.play).replace('<svg', '<svg class="i-play"')}</button>
          <button class="icon" data-a="mini" title="Minimize">${svg(I.mini)}</button>
          <button class="icon" data-a="stop" title="Stop and close">${svg(I.close)}</button>
        </div>
        <div class="body">
          <div class="stage">
            <div class="text" aria-live="off"></div>
            <div class="skeleton"><span></span><span></span><span></span></div>
          </div>
          <div class="status">Getting ready</div>
          <div class="err"></div>
          <div class="track" title="Jump to sentence"><div class="fill"></div><div class="knob"></div><div class="hover-tip"></div></div>
          <div class="times"><span class="count"></span><span class="left"></span></div>
          <div class="ctl">
            <button class="chip speed" title="Speed — click to speed up, Shift-click to slow down">1.0×</button>
            <div class="mid">
              <button class="skip" data-a="prev" title="Previous sentence">${svg(I.prev)}</button>
              <button class="play" data-a="toggle" title="Pause / resume (Alt+Shift+P)">${svg(I.pause).replace('<svg', '<svg class="i-pause"')}${svg(I.play).replace('<svg', '<svg class="i-play"')}</button>
              <button class="skip" data-a="next" title="Next sentence">${svg(I.next)}</button>
            </div>
            <button class="chip toggle on" data-follow title="Auto-scroll the page to follow along">${svg(I.follow)}Follow</button>
          </div>
        </div>
        <div class="bar-mini"></div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { p: $('.p'), head: $('.head'), title: $('.title'), sub: $('.sub'), text: $('.text'), status: $('.status'), err: $('.err'),
           track: $('.track'), fill: $('.fill'), knob: $('.knob'), tip: $('.hover-tip'), count: $('.count'), left: $('.left'),
           speed: $('.speed'), follow: $('[data-follow]'), mini: $('[data-a="mini"]'), barMini: $('.bar-mini') };
    ui.title.textContent = title || document.title || 'Voxly';
    const engineLabel = engine === 'kokoro' ? 'Neural' : 'Standard';
    ui.sub.innerHTML = '';
    ui.sub.append(Object.assign(document.createElement('b'), { textContent: engineLabel }), ` · ${prettyVoice(voice)}`);

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'mini') return toggleMini();
      if (a === 'stop') { chrome.runtime.sendMessage({ type: 'control', action: 'stop' }); return close(); }
      if (a) return chrome.runtime.sendMessage({ type: 'control', action: a });
      if (b === ui.speed) return cycleSpeed(e.shiftKey ? -1 : 1);
      if (b === ui.follow) { follow = !follow; ui.follow.classList.toggle('on', follow); }
    });
    ui.track.addEventListener('click', (e) => {
      const r = ui.track.getBoundingClientRect();
      const idx = Math.min(chunks.length - 1, Math.floor(((e.clientX - r.left) / r.width) * chunks.length));
      chrome.runtime.sendMessage({ type: 'control', action: 'seek', index: idx });
    });
    ui.track.addEventListener('mousemove', (e) => {
      const r = ui.track.getBoundingClientRect();
      const f = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
      ui.tip.style.left = f * 100 + '%';
      ui.tip.textContent = `Sentence ${Math.min(chunks.length, Math.floor(f * chunks.length) + 1)}`;
    });
    makeDraggable();
    document.documentElement.appendChild(host);
  }

  function prettyVoice(v) {
    if (!v) return 'System voice';
    const m = /^([ab])([fm])_(\w+)$/.exec(v); // Kokoro ids like af_heart
    if (m) return `${m[3][0].toUpperCase() + m[3].slice(1)} (${m[1] === 'a' ? 'US' : 'UK'})`;
    return v;
  }

  function makeDraggable() {
    const { head, p } = ui;
    let sx = null, ox, oy, moved = false;
    chrome.storage.local.get({ playerPos: null }).then(({ playerPos }) => { if (playerPos) place(playerPos.left, playerPos.top); });
    function place(left, top) {
      const w = p.offsetWidth, h = p.offsetHeight;
      p.style.left = Math.min(Math.max(8, left), innerWidth - w - 8) + 'px';
      p.style.top = Math.min(Math.max(8, top), innerHeight - h - 8) + 'px';
      p.style.right = 'auto'; p.style.bottom = 'auto';
    }
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = p.getBoundingClientRect();
      sx = e.clientX; ox = r.left; oy = r.top; moved = false; head.setPointerCapture(e.pointerId);
      p.style.transition = 'none';
      head.sy = e.clientY;
    });
    head.addEventListener('pointermove', (e) => {
      if (sx == null) return;
      moved = true;
      place(ox + e.clientX - sx, oy + e.clientY - head.sy);
    });
    head.addEventListener('pointerup', () => {
      if (sx == null) return;
      sx = null; p.style.transition = '';
      if (moved) chrome.storage.local.set({ playerPos: { left: parseFloat(p.style.left), top: parseFloat(p.style.top) } });
    });
  }

  function toggleMini() {
    const mini = !ui.p.classList.contains('mini');
    ui.p.classList.toggle('mini', mini);
    ui.mini.innerHTML = svg(mini ? I.expand : I.mini);
    ui.mini.title = mini ? 'Expand' : 'Minimize';
  }

  const fmtRate = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2))) + '×';

  function cycleSpeed(dir) {
    let i = SPEEDS.findIndex((s) => s >= rate - 0.01);
    if (i < 0) i = SPEEDS.length - 1;
    i = (i + dir + SPEEDS.length) % SPEEDS.length;
    chrome.runtime.sendMessage({ type: 'setRate', rate: SPEEDS[i] });
  }

  function setState(s) {
    state = s;
    if (ui.p) ui.p.dataset.state = s;
  }

  function renderSentence(animate) {
    if (!host) return;
    ui.text.textContent = chunks[current] || '';
    if (animate) { ui.text.classList.remove('swap'); void ui.text.offsetWidth; ui.text.classList.add('swap'); }
    ui.text.scrollTop = 0;
    const pct = ((current + 1) / Math.max(chunks.length, 1)) * 100;
    ui.fill.style.width = pct + '%';
    ui.knob.style.left = pct + '%';
    ui.barMini.style.width = pct + '%';
    ui.count.textContent = `Sentence ${current + 1} of ${chunks.length}`;
    let remaining = 0;
    for (let i = current; i < words.length; i++) remaining += words[i];
    const mins = remaining / (160 * rate);
    ui.left.textContent = mins < 1 ? `${Math.max(1, Math.round(mins * 60))}s left` : `~${Math.round(mins)} min left`;
  }

  function renderWord(charIndex, length) {
    const t = chunks[current] || '';
    if (charIndex == null || charIndex < 0 || charIndex >= t.length) return;
    let len = length;
    if (!len) { const m = t.slice(charIndex).match(/^\S+/); len = m ? m[0].length : 1; }
    const mark = document.createElement('mark');
    mark.textContent = t.slice(charIndex, charIndex + len);
    ui.text.replaceChildren(t.slice(0, charIndex), mark, t.slice(charIndex + len));
    const mr = mark.offsetTop - ui.text.offsetTop;
    if (mr > ui.text.scrollTop + ui.text.clientHeight - 30 || mr < ui.text.scrollTop) ui.text.scrollTo({ top: mr - 30, behavior: 'smooth' });
  }

  function close() {
    clearHighlights();
    if (!host) return;
    const h = host;
    host = null;
    ui.p.classList.add('leaving');
    setTimeout(() => h.remove(), 230);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'voxly:extract': sendResponse(extract(msg.mode)); return false;
      case 'voxly:open':
        chunks = msg.chunks; starts = msg.starts; current = 0; rate = Number(msg.rate) || 1;
        words = chunks.map((c) => c.split(' ').length);
        if (msg.unmapped) map = null;
        build(msg);
        ui.speed.textContent = fmtRate(rate);
        setState(msg.engine === 'kokoro' ? 'loading' : 'playing');
        renderSentence(false);
        highlightSentence(0);
        break;
      case 'voxly:chunk':
        if (!host) break;
        if (msg.index !== current || state === 'loading') {
          current = msg.index;
          renderSentence(true);
          highlightSentence(current);
        }
        if (state === 'loading') setState('playing');
        break;
      case 'voxly:word':
        if (!host || msg.index !== current) break;
        if (state === 'loading') setState('playing');
        renderWord(msg.charIndex, msg.length);
        highlightWord(current, msg.charIndex, msg.length);
        break;
      case 'voxly:state': setState(msg.paused ? 'paused' : 'playing'); break;
      case 'voxly:rate':
        rate = Number(msg.rate);
        if (ui.speed) {
          ui.speed.textContent = fmtRate(rate);
          ui.speed.classList.remove('bump'); void ui.speed.offsetWidth; ui.speed.classList.add('bump');
          renderSentence(false);
        }
        break;
      case 'voxly:loading':
        if (!host) break;
        if (msg.done) { if (state === 'loading') setState('playing'); break; }
        setState('loading');
        ui.status.textContent = msg.text ? msg.text.replace(/…$/, '')
          : msg.percent < 100 ? `Downloading neural voice (first time only) — ${msg.percent}%` : 'Warming up the neural voice';
        break;
      case 'voxly:error':
        if (ui.err) { ui.err.textContent = msg.message; ui.err.style.display = 'block'; setState('paused'); }
        break;
      case 'voxly:close': close(); break;
    }
    return false;
  });
})();
