// Voxly content script: text extraction + floating player with word highlighting.
(() => {
  if (window.__voxlyLoaded) return;
  window.__voxlyLoaded = true;

  function extract(mode) {
    const sel = String(window.getSelection() || '').trim();
    if (mode !== 'page' && sel) return { text: sel, title: document.title };
    let text = '';
    try {
      // Readability strips nav, ads and footers so only the article gets read.
      const article = new Readability(document.cloneNode(true)).parse();
      if (article?.textContent && article.textContent.trim().length > 200) {
        text = (article.title ? article.title + '. ' : '') + article.textContent;
      }
    } catch (e) { /* fall through */ }
    if (!text) text = document.body ? document.body.innerText : '';
    return { text, title: document.title };
  }

  let host = null, ui = {}, chunks = [], current = 0, paused = false;

  const CSS = `
    :host { all: initial; }
    .p { position: fixed; right: 20px; bottom: 20px; width: 360px; max-width: calc(100vw - 40px);
         background: #16131f; color: #eee; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.35);
         font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #221d31; cursor: move; user-select: none; }
    .logo { width: 18px; height: 18px; border-radius: 5px; background: linear-gradient(135deg,#8b6cff,#5b3df5); }
    .title { flex: 1; font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .count { font-size: 12px; color: #aaa; font-variant-numeric: tabular-nums; }
    .text { padding: 12px 14px; max-height: 120px; overflow: auto; color: #cfcfe0; }
    mark { background: #8b6cff; color: #fff; border-radius: 3px; padding: 0 2px; }
    .bar { height: 3px; background: #2c2640; } .bar > i { display: block; height: 100%; width: 0; background: #8b6cff; transition: width .2s; }
    .ctl { display: flex; align-items: center; gap: 6px; padding: 10px 12px; }
    button { all: unset; cursor: pointer; display: grid; place-items: center; min-width: 34px; height: 34px; padding: 0 6px;
             border-radius: 8px; background: #2a2440; color: #fff; font-size: 15px; box-sizing: border-box; }
    button:hover { background: #3a3258; } button.main { background: #6d4aff; min-width: 44px; } button.main:hover { background: #7f60ff; }
    .spacer { flex: 1; } .rate { font-size: 12px; min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
    .err { color: #ff8f8f; padding: 0 14px 10px; font-size: 12px; display: none; }
  `;

  function build(title) {
    if (host) { ui.title.textContent = title || 'Voxly'; return; }
    host = document.createElement('voxly-player');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${CSS}</style>
      <div class="p" part="panel">
        <div class="head"><div class="logo"></div><div class="title"></div><div class="count"></div></div>
        <div class="bar"><i></i></div>
        <div class="text" aria-live="polite"></div>
        <div class="err"></div>
        <div class="ctl">
          <button data-a="prev" title="Previous sentence">⏮</button>
          <button data-a="toggle" class="main" title="Pause / resume (Alt+Shift+P)">❚❚</button>
          <button data-a="next" title="Next sentence">⏭</button>
          <div class="spacer"></div>
          <button data-r="-0.1" title="Slower">−</button>
          <div class="rate">1.0×</div>
          <button data-r="0.1" title="Faster">+</button>
          <button data-a="stop" title="Stop and close">✕</button>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    ui = { panel: $('.p'), head: $('.head'), title: $('.title'), count: $('.count'), text: $('.text'),
           bar: $('.bar > i'), toggle: $('[data-a="toggle"]'), rate: $('.rate'), err: $('.err') };
    ui.title.textContent = title || 'Voxly';

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a) chrome.runtime.sendMessage({ type: 'control', action: b.dataset.a });
      if (b.dataset.r) chrome.runtime.sendMessage({ type: 'setRate', delta: Number(b.dataset.r) });
    });
    makeDraggable(ui.head, ui.panel);
    document.documentElement.appendChild(host);
  }

  function makeDraggable(handle, panel) {
    let sx, sy, ox, oy;
    handle.addEventListener('pointerdown', (e) => {
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (sx == null) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => { sx = null; });
  }

  function render(charIndex, length) {
    if (!host) return;
    const t = chunks[current] || '';
    ui.text.replaceChildren();
    if (charIndex == null || charIndex < 0 || charIndex >= t.length) {
      ui.text.append(t);
    } else {
      let len = length;
      if (!len) { const m = t.slice(charIndex).match(/^\S+/); len = m ? m[0].length : 1; }
      const mark = document.createElement('mark');
      mark.textContent = t.slice(charIndex, charIndex + len);
      ui.text.append(t.slice(0, charIndex), mark, t.slice(charIndex + len));
    }
    ui.count.textContent = `${current + 1} / ${chunks.length}`;
    ui.bar.style.width = `${((current + 1) / Math.max(chunks.length, 1)) * 100}%`;
  }

  function setPaused(p) {
    paused = p;
    if (ui.toggle) ui.toggle.textContent = p ? '▶' : '❚❚';
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'voxly:extract': sendResponse(extract(msg.mode)); return false;
      case 'voxly:open':
        chunks = msg.chunks; current = 0; build(msg.title);
        ui.err.style.display = 'none';
        ui.rate.textContent = Number(msg.rate || 1).toFixed(1) + '×';
        setPaused(false); render(); break;
      case 'voxly:chunk': current = msg.index; setPaused(false); render(); break;
      case 'voxly:word': if (msg.index === current) render(msg.charIndex, msg.length); break;
      case 'voxly:state': setPaused(msg.paused); break;
      case 'voxly:rate': if (ui.rate) ui.rate.textContent = Number(msg.rate).toFixed(1) + '×'; break;
      case 'voxly:error': if (ui.err) { ui.err.textContent = msg.message; ui.err.style.display = 'block'; } break;
      case 'voxly:close': if (host) { host.remove(); host = null; ui = {}; } break;
    }
    return false;
  });
})();
