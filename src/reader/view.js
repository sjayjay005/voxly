// Reader view: the page as plain, well-set text, with one control dock.
// Rendering rules that keep it light on weak machines:
//  - one shadow root, built once; no per-word DOM rewrites (a single marker element moves between words)
//  - only transform/opacity/background transitions; no blur, no infinite animations except while buffering
//  - long articles use content-visibility so off-screen paragraphs cost nothing to lay out
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.createView) return;

  const ICON = {
    play: '<path d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l10-6.4c.6-.4.6-1.3 0-1.7l-10-6.3C8.9 4.3 8 4.8 8 5.6z"/>',
    pause: '<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>',
    replay: '<path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>',
    prev: '<path d="M6 6h2v12H6zM18.5 6.9v10.2c0 .7-.8 1.1-1.4.7l-7.3-5.1a.9.9 0 0 1 0-1.4l7.3-5.1c.6-.4 1.4 0 1.4.7z"/>',
    next: '<path d="M16 6h2v12h-2zM5.5 6.9v10.2c0 .7.8 1.1 1.4.7l7.3-5.1a.9.9 0 0 0 0-1.4L6.9 6.2c-.6-.4-1.4 0-1.4.7z"/>',
    close: '<path d="M6.7 5.3 12 10.6l5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3z"/>'
  };
  const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const fmtSpeed = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2))) + '×';

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .root {
    --paper: #F5F6F2; --ink: #1E2230; --muted: #6A6F7E; --rule: #E2E4DD;
    --marker: #FFE45C; --sentence: rgba(255, 228, 92, .26);
    --dock: #1E2230; --dock-ink: #F5F6F2; --dock-muted: #A9ADBA; --brand: #5B3DF5; --brand-ink: #fff;
    position: fixed; inset: 0; z-index: 2147483647; background: var(--paper); color: var(--ink);
    font: 400 21px/1.68 Charter, "Bitstream Charter", "Iowan Old Style", "Sitka Text", Cambria, Georgia, serif;
    -webkit-font-smoothing: antialiased; animation: open .28s cubic-bezier(.2,.8,.2,1) both;
  }
  @media (prefers-color-scheme: dark) {
    .root { --paper: #16171B; --ink: #E6E5DF; --muted: #8E919B; --rule: #2A2C33;
            --marker: rgba(233, 201, 58, .42); --sentence: rgba(233, 201, 58, .12);
            --dock: #24262D; --dock-ink: #ECEBE6; --dock-muted: #9EA1AB; --brand: #8C74FF; }
  }
  .root:focus { outline: none; }
  .root.closing { animation: shut .18s ease-in both; }
  @keyframes open { from { opacity: 0; transform: translateY(12px); } }
  @keyframes shut { to { opacity: 0; transform: translateY(8px); } }

  .scroller { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; scroll-padding: 30vh 0; }
  .top { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between;
         padding: 14px 22px; background: var(--paper); font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--muted); }
  .top .site { letter-spacing: .01em; }
  .close { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .close:hover { color: var(--ink); }
  .close svg { width: 16px; height: 16px; fill: currentColor; }
  .close kbd { font: inherit; font-size: 11px; padding: 2px 5px; border: 1px solid var(--rule); border-radius: 4px; }

  .column { position: relative; max-width: 34em; margin: 0 auto; padding: 28px 24px 200px; }
  .column > :not(.marker) { position: relative; z-index: 1; }
  h1.title { font-size: 1.9em; line-height: 1.15; font-weight: 700; letter-spacing: -.015em; margin: 0 0 .25em; text-wrap: balance; }
  .meta { font: 400 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--muted); margin: 0 0 2.2em; }
  p, li, blockquote, h2, pre { margin: 0 0 1em; content-visibility: auto; contain-intrinsic-size: auto 4em; }
  h2 { font-size: 1.2em; line-height: 1.3; font-weight: 700; margin-top: 1.6em; }
  ul { margin: 0 0 1em; padding-left: 1.2em; }
  blockquote { padding-left: 1em; border-left: 3px solid var(--rule); color: var(--muted); font-style: italic; }
  pre { font: 15px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; background: rgba(127,127,127,.08); padding: .8em 1em; border-radius: 6px; }
  .s { cursor: pointer; border-radius: 3px; transition: background-color .25s; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
  .s:hover { background: rgba(127,127,127,.09); }
  .s.on { background: var(--sentence); }
  .marker { position: absolute; left: 0; top: 0; height: 1.32em; width: 0; z-index: 0; pointer-events: none;
            background: var(--marker); border-radius: 3px 6px 4px 7px; opacity: 0;
            transition: transform .14s cubic-bezier(.3,.7,.3,1), width .14s cubic-bezier(.3,.7,.3,1), opacity .2s; will-change: transform; }
  .marker.on { opacity: 1; }

  /* dock */
  .dock { position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 4; width: min(760px, calc(100% - 24px));
          display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 10px 14px 10px 10px;
          background: var(--dock); color: var(--dock-ink); border-radius: 18px; box-shadow: 0 14px 40px -18px rgba(20,22,35,.55);
          font: 500 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; overflow: hidden; }
  .transport { display: flex; align-items: center; gap: 2px; }
  button { all: unset; cursor: pointer; display: inline-grid; place-items: center; border-radius: 10px; -webkit-tap-highlight-color: transparent; }
  button:focus-visible, select:focus-visible, .switch:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .skip { width: 36px; height: 36px; color: var(--dock-muted); } .skip:hover { color: var(--dock-ink); background: rgba(255,255,255,.07); }
  .skip svg { width: 20px; height: 20px; fill: currentColor; }
  .play { position: relative; width: 46px; height: 46px; border-radius: 14px; background: var(--brand); color: var(--brand-ink); margin-right: 4px;
          transition: transform .12s; }
  .play:active { transform: scale(.94); }
  .play svg { position: absolute; width: 22px; height: 22px; fill: currentColor; transition: opacity .15s, transform .2s cubic-bezier(.3,1.3,.5,1); }
  .play .i-play, .play .i-replay { opacity: 0; transform: scale(.5); }
  [data-state="paused"] .play .i-pause, [data-state="ended"] .play .i-pause, [data-state="error"] .play .i-pause { opacity: 0; transform: scale(.5); }
  [data-state="paused"] .play .i-play, [data-state="error"] .play .i-play { opacity: 1; transform: none; }
  [data-state="ended"] .play .i-replay { opacity: 1; transform: none; }
  .play .ring { position: absolute; left: -4px; top: -4px; width: 54px; height: 54px; opacity: 0; transform: none; transition: opacity .2s; pointer-events: none; fill: none; }
  .ring circle { fill: none; stroke-width: 3; }
  .ring .rt { stroke: rgba(255,255,255,.12); }
  .ring .rp { stroke: var(--brand); stroke-linecap: round; stroke-dasharray: 150.8; stroke-dashoffset: 150.8;
              transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset .4s; }
  [data-state="buffering"] .play { background: transparent; color: var(--dock-ink); }
  [data-state="buffering"] .play .ring { opacity: 1; }
  [data-state="buffering"] .play .i-pause { width: 18px; height: 18px; }
  [data-state="buffering"] .ring.spin .rp { stroke-dashoffset: 113; animation: spin 1.1s linear infinite; }
  @keyframes spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }

  .progress { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; padding-right: 4px; }
  .track { position: relative; height: 6px; border-radius: 3px; background: rgba(255,255,255,.12); cursor: pointer; }
  .track::before { content: ''; position: absolute; inset: -8px 0; } /* bigger hit area */
  .fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: var(--dock-ink); transition: width .3s; }
  .buffer { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: var(--brand); opacity: 0; transition: width .3s, opacity .2s; }
  [data-state="buffering"] .buffer { opacity: 1; }
  [data-state="buffering"] .fill { opacity: 0; }
  .line { display: flex; justify-content: space-between; gap: 12px; color: var(--dock-muted); white-space: nowrap; }
  .status { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .left { flex: none; }
  [data-state="error"] .left { display: none; }
  [data-state="error"] .status { color: #FF9B8F; white-space: normal; }
  .left { font-variant-numeric: tabular-nums; }

  .settings { display: flex; align-items: center; gap: 10px; }
  .speed { display: inline-flex; align-items: center; border-radius: 10px; background: rgba(255,255,255,.07); }
  .speed button { width: 26px; height: 30px; color: var(--dock-muted); font-size: 16px; } .speed button:hover { color: var(--dock-ink); }
  .speed output { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
  .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--dock-muted); user-select: none; }
  .switch .knob { position: relative; width: 32px; height: 18px; border-radius: 9px; background: rgba(255,255,255,.18); transition: background .2s; }
  .switch .knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .2s cubic-bezier(.3,1.3,.5,1); }
  .switch[aria-checked="true"] { color: var(--dock-ink); }
  .switch[aria-checked="true"] .knob { background: var(--brand); }
  .switch[aria-checked="true"] .knob::after { transform: translateX(14px); }
  select { all: unset; cursor: pointer; max-width: 150px; padding: 7px 24px 7px 10px; border-radius: 10px; background: rgba(255,255,255,.07)
           url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23A9ADBA' fill='none' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 9px center;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dock-ink); }
  select option { color: #1E2230; background: #fff; }

  .hint { position: absolute; left: 50%; bottom: 96px; transform: translate(-50%, 10px); z-index: 4; opacity: 0; pointer-events: none;
          display: flex; align-items: center; gap: 12px; max-width: min(620px, calc(100% - 24px)); padding: 10px 10px 10px 16px; border-radius: 14px;
          background: var(--dock); color: var(--dock-ink); font: 400 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
          transition: opacity .2s, transform .2s; }
  .hint.on { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
  .hint button { flex: none; padding: 7px 11px; border-radius: 9px; background: var(--brand); color: var(--brand-ink); font-weight: 600; }
  .hint .x { background: none; color: var(--dock-muted); padding: 7px; }
  .back { position: absolute; left: 50%; bottom: 96px; transform: translate(-50%, 10px); z-index: 4; opacity: 0; pointer-events: none;
          padding: 8px 14px; border-radius: 999px; background: var(--dock); color: var(--dock-ink);
          font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; transition: opacity .2s, transform .2s; }
  .back.on { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }

  @media (max-width: 640px) {
    .root { font-size: 19px; }
    .dock { grid-template-columns: auto minmax(0, 1fr); } .settings { grid-column: 1 / -1; justify-content: space-between; }
    .back { bottom: 150px; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: .01ms !important; transition-duration: .01ms !important; } }
  `;

  VX.createView = function createView(doc, act) {
    const host = document.createElement('voxly-reader');
    const shadow = host.attachShadow({ mode: 'open' });
    const totalChars = doc.sentences.reduce((n, s) => n + s.length, 0);
    const minutes = Math.max(1, Math.round(totalChars / 14.5 / 60));

    shadow.innerHTML = `<style>${CSS}</style>
      <div class="root" data-state="buffering" role="dialog" aria-label="Voxly reader" tabindex="-1">
        <div class="scroller">
          <div class="top"><span class="site"></span><button class="close" title="Close reader">${svg('close')}<kbd>Esc</kbd></button></div>
          <article class="column"><div class="marker"></div></article>
        </div>
        <button class="back">Back to where it's reading</button>
        <div class="hint" role="status"><span class="hint-text"></span><button class="hint-act"></button><button class="x" title="Dismiss">✕</button></div>
        <div class="dock">
          <div class="transport">
            <button class="play" title="Play / pause (Space)"><svg class="ring spin" viewBox="0 0 54 54" aria-hidden="true"><circle class="rt" cx="27" cy="27" r="24"/><circle class="rp" cx="27" cy="27" r="24"/></svg>${svg('pause', 'i-pause')}${svg('play', 'i-play')}${svg('replay', 'i-replay')}</button>
            <button class="skip" data-skip="-1" title="Previous sentence (←)">${svg('prev')}</button>
            <button class="skip" data-skip="1" title="Next sentence (→)">${svg('next')}</button>
          </div>
          <div class="progress">
            <div class="track" title="Jump to a point in the article"><div class="buffer"></div><div class="fill"></div></div>
            <div class="line"><span class="status"></span><span class="left"></span></div>
          </div>
          <div class="settings">
            <div class="speed"><button data-speed="-1" title="Slower">−</button><output></output><button data-speed="1" title="Faster">+</button></div>
            <div class="switch" role="switch" tabindex="0" aria-checked="false" title="Natural voice runs on your computer. First use downloads it once (about 90 MB).">
              <span class="knob"></span><span>Natural voice</span></div>
            <select class="voice" title="Voice"></select>
          </div>
        </div>
      </div>`;

    const $ = (s) => shadow.querySelector(s);
    const el = { ring: $('.ring'), rp: $('.ring .rp'), root: $('.root'), scroller: $('.scroller'), column: $('.column'), marker: $('.marker'), back: $('.back'),
                 fill: $('.fill'), buffer: $('.buffer'), track: $('.track'), status: $('.status'), left: $('.left'),
                 speed: $('.speed output'), sw: $('.switch'), voice: $('.voice') };
    $('.site').textContent = doc.site;

    // ---- article ----
    const spans = new Array(doc.sentences.length);
    const frag = document.createDocumentFragment();
    let list = null;
    for (const block of doc.blocks) {
      let node;
      if (block.kind === 'title') {
        node = document.createElement('h1'); node.className = 'title';
      } else if (block.kind === 'item') {
        if (!list) { list = document.createElement('ul'); frag.append(list); }
        node = document.createElement('li');
      } else {
        list = null;
        node = document.createElement(block.kind === 'heading' ? 'h2' : block.kind === 'quote' ? 'blockquote' : block.kind === 'code' ? 'pre' : 'p');
      }
      block.sentences.forEach(({ text, index }, k) => {
        const s = document.createElement('span');
        s.className = 's';
        s.dataset.i = index;
        s.textContent = text;
        spans[index] = s;
        if (k) node.append(' ');
        node.append(s);
      });
      (block.kind === 'item' ? list : frag).append(node);
      if (block.kind === 'title') {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${minutes} minute listen`;
        frag.append(meta);
      }
    }
    el.column.append(frag);

    // ---- state ----
    let active = -1, follow = true, rate = 1, state = 'buffering', userScrollAt = 0, settings = null;

    const timeLeft = () => {
      let chars = 0;
      for (let i = Math.max(active, 0); i < doc.sentences.length; i++) chars += doc.sentences[i].length;
      const secs = chars / (14.5 * rate);
      return secs < 60 ? `${Math.max(1, Math.round(secs))} sec left` : `${Math.round(secs / 60)} min left`;
    };

    function scrollToActive(force) {
      const s = spans[active];
      if (!s) return;
      const r = s.getBoundingClientRect();
      const h = el.scroller.clientHeight;
      if (force || r.top < 70 || r.bottom > h * 0.72) {
        el.scroller.scrollTo({ top: el.scroller.scrollTop + r.top - h * 0.3, behavior: 'smooth' });
      }
    }

    // Programmatic smooth scrolls also fire 'scroll'; only wheel/touch/keys mean the user took over.
    const takeOver = () => { userScrollAt = Date.now(); if (follow) { follow = false; el.back.classList.add('on'); } };
    el.scroller.addEventListener('wheel', takeOver, { passive: true });
    el.scroller.addEventListener('touchmove', takeOver, { passive: true });
    el.back.addEventListener('click', () => { follow = true; el.back.classList.remove('on'); scrollToActive(true); });

    const hint = { box: $('.hint'), text: $('.hint-text'), act: $('.hint-act') };
    hint.act.addEventListener('click', () => { hint.box.classList.remove('on'); act.settings({ natural: false }); });
    $('.hint .x').addEventListener('click', () => hint.box.classList.remove('on'));

    // ---- events ----
    el.column.addEventListener('click', (e) => {
      const s = e.target.closest('.s');
      if (s) act.seek(Number(s.dataset.i));
    });
    $('.close').addEventListener('click', () => act.close());
    $('.play').addEventListener('click', () => act.toggle());
    for (const b of shadow.querySelectorAll('[data-skip]')) b.addEventListener('click', () => act.seek(active + Number(b.dataset.skip)));
    for (const b of shadow.querySelectorAll('[data-speed]')) b.addEventListener('click', () => stepSpeed(Number(b.dataset.speed)));
    const toggleNatural = () => act.settings({ natural: el.sw.getAttribute('aria-checked') !== 'true' });
    el.sw.addEventListener('click', toggleNatural);
    el.sw.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); toggleNatural(); } });
    el.voice.addEventListener('change', () => act.settings(settings.natural ? { neuralVoice: el.voice.value } : { systemVoice: el.voice.value }));
    el.track.addEventListener('click', (e) => {
      const r = el.track.getBoundingClientRect();
      // Map the click to a sentence by character position, so long sentences take up proportionally more track.
      const target = ((e.clientX - r.left) / r.width) * totalChars;
      let acc = 0, i = 0;
      while (i < doc.sentences.length - 1 && acc + doc.sentences[i].length < target) acc += doc.sentences[i++].length;
      act.seek(i);
    });

    function stepSpeed(dir) {
      let i = SPEEDS.findIndex((s) => s >= rate - 0.001);
      if (i < 0) i = SPEEDS.length - 1;
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))];
      if (next !== rate) act.settings({ rate: next });
    }

    function onKey(e) {
      if (e.target !== host && !e.composedPath().includes(host) && e.key !== 'Escape') return;
      const inSelect = e.composedPath()[0]?.tagName === 'SELECT';
      let handled = true;
      if (e.key === 'Escape') act.close();
      else if (inSelect) handled = false;
      else if (e.key === ' ' || e.key === 'k') act.toggle();
      else if (e.key === 'ArrowRight') act.seek(active + 1);
      else if (e.key === 'ArrowLeft') act.seek(active - 1);
      else if (e.key === '+' || e.key === '=') stepSpeed(1);
      else if (e.key === '-') stepSpeed(-1);
      else if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) { takeOver(); handled = false; }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
    window.addEventListener('keydown', onKey, true);

    // Lock the page behind the reader.
    const prevOverflow = [document.documentElement.style.overflow, document.body?.style.overflow];
    document.documentElement.style.overflow = 'hidden';
    if (document.body) document.body.style.overflow = 'hidden';
    document.documentElement.append(host);
    el.root.focus({ preventScroll: true });

    // ---- API used by the controller ----
    return {
      setSettings(s, voices) {
        settings = s;
        rate = Number(s.rate) || 1;
        el.speed.textContent = fmtSpeed(rate);
        el.sw.setAttribute('aria-checked', String(!!s.natural));
        if (voices) this.voices = voices;
        const list = s.natural ? this.voices.neural : this.voices.system;
        const want = s.natural ? s.neuralVoice : s.systemVoice;
        el.voice.replaceChildren(...(s.natural ? [] : [new Option('Default voice', '')]),
          ...list.map((v) => new Option(v.label, v.id)));
        el.voice.value = list.some((v) => v.id === want) ? want : (s.natural ? list[0]?.id : '');
        el.left.textContent = timeLeft();
      },
      setState(next, detail = '', progress = null) {
        state = next;
        el.root.dataset.state = next;
        // "Preparing natural voice — about 40s": the wait goes in the right-hand slot so it never gets truncated.
        const [label, eta] = next === 'buffering' ? (detail || 'Getting ready').split(' — ') : [];
        el.left.textContent = next === 'buffering' ? (eta || '').replace(/^about /, '~') : timeLeft();
        el.status.textContent =
          next === 'buffering' ? label :
          next === 'paused' ? 'Paused' :
          next === 'ended' ? 'Finished' :
          next === 'error' ? detail || 'Something went wrong. Press play to try again.' :
          `Sentence ${active + 1} of ${doc.sentences.length}`;
        // Determinate ring when we know how far along buffering is, a spinner when we don't.
        const p = progress == null ? null : Math.min(1, Math.max(0, progress));
        el.ring.classList.toggle('spin', p == null);
        el.rp.style.strokeDashoffset = p == null ? '' : String(150.8 * (1 - Math.max(p, 0.04)));
        if (p != null) el.buffer.style.width = Math.round(p * 100) + '%';
        el.status.title = el.status.textContent;
        if (next !== 'playing' && next !== 'paused') el.marker.classList.remove('on');
      },
      setSentence(i) {
        if (i === active) return;
        spans[active]?.classList.remove('on');
        active = i;
        const s = spans[i];
        if (!s) return;
        s.classList.add('on');
        el.marker.classList.remove('on');
        let before = 0;
        for (let k = 0; k < i; k++) before += doc.sentences[k].length;
        el.fill.style.width = (before / totalChars) * 100 + '%';
        el.left.textContent = timeLeft();
        if (state === 'playing') el.status.textContent = `Sentence ${i + 1} of ${doc.sentences.length}`;
        if (follow || Date.now() - userScrollAt > 15000) { follow = true; el.back.classList.remove('on'); scrollToActive(false); }
      },
      setWord(i, charIndex, length) {
        const s = spans[i];
        const node = s?.firstChild;
        if (!node || charIndex < 0 || charIndex >= node.length) return;
        if (!length) { const m = /^\S+/.exec(node.data.slice(charIndex)); length = m ? m[0].length : 1; }
        const range = document.createRange();
        range.setStart(node, charIndex);
        range.setEnd(node, Math.min(node.length, charIndex + length));
        const r = range.getClientRects()[0];
        if (!r) return;
        const c = el.column.getBoundingClientRect();
        const padX = 3, padY = (r.height * 0.32) / 2;
        el.marker.style.width = r.width + padX * 2 + 'px';
        el.marker.style.height = r.height * 0.68 + 'px';
        el.marker.style.transform = `translate(${r.left - c.left - padX}px, ${r.top - c.top + r.height * 0.24 + padY * 0}px)`;
        el.marker.classList.add('on');
      },
      clearWord() { el.marker.classList.remove('on'); },
      setHint(text, action) {
        hint.text.textContent = text;
        hint.act.textContent = action || 'OK';
        hint.box.classList.add('on');
        el.back.classList.remove('on');
      },
      get active() { return active; },
      get state() { return state; },
      destroy() {
        window.removeEventListener('keydown', onKey, true);
        document.documentElement.style.overflow = prevOverflow[0];
        if (document.body) document.body.style.overflow = prevOverflow[1];
        el.root.classList.add('closing');
        setTimeout(() => host.remove(), 180);
      },
      voices: { system: [], neural: [] }
    };
  };
})();
