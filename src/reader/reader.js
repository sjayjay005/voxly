// Reader controller: extract → render → talk to the service worker over one Port.
// Holds no state between sessions; closing the reader drops the document model, the view and the Port.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.reader) return;

  let session = null; // { port, view, doc, clock }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'voxly:toggle') session ? close() : open();
  });

  function open() {
    const doc = VX.extract();
    if (!doc.sentences.length) { alert("Voxly couldn't find any text to read on this page."); return; }
    const s = (session = { port: null, doc, view: null, clock: null, heartbeat: 0, resumeAt: doc.startAt, retries: 0 });
    const send = (type, data = {}) => { try { s.port.postMessage({ type, ...data }); } catch {} };
    s.send = send;
    s.view = VX.createView(doc, {
      toggle() {
        const st = s.view.state;
        if (st === 'playing' || st === 'buffering') send('pause');
        else if (st === 'paused') send('resume');
        else send('play', { index: st === 'ended' ? 0 : Math.max(s.view.active, 0) });
      },
      seek(i) { if (i >= 0 && i < doc.sentences.length) send('play', { index: i }); },
      settings(patch) { send('settings', { patch }); },
      close
    });
    s.view.setState('buffering', 'Getting ready');
    connect(s);
    // Chrome stops an idle extension service worker after ~30s. A slow machine can spend longer than that
    // generating one sentence, so keep the connection warm while the reader is open.
    s.heartbeat = setInterval(() => send('ping'), 20_000);
  }

  function connect(s) {
    const port = chrome.runtime.connect({ name: 'voxly-reader' });
    s.port = port;
    port.onMessage.addListener((m) => onMessage(s, m));
    port.onDisconnect.addListener(() => reconnect(s, port));
    s.send('hello', { lang: document.documentElement.lang || navigator.language });
    // If a restarting service worker accepts the connection but never answers, try again.
    clearTimeout(s.helloTimer);
    s.helloTimer = setTimeout(() => { if (session === s && s.port === port) { try { port.disconnect(); } catch {} reconnect(s, port); } }, 5000);
  }

  // The service worker restarted (Chrome stops idle ones, and updates restart them). Reconnect and
  // carry on from the current sentence, playing again only if we were playing before.
  function reconnect(s, port) {
    if (session !== s || s.port !== port) return;
    s.port = null;
    stopClock(s);
    if (s.autoplay === undefined || !s.reconnecting) {
      s.autoplay = ['playing', 'buffering'].includes(s.view.state);
      s.resumeAt = Math.max(s.view.active, 0);
    }
    s.reconnecting = true;
    if (++s.retries > 4) { s.view.setState('error', 'Voxly lost its connection. Close the reader and open it again.'); return; }
    s.view.setState('buffering', 'Reconnecting');
    setTimeout(() => { if (session === s) connect(s); }, 600 * s.retries);
  }

  function onMessage(s, m) {
    if (session !== s) return;
    const { view } = s;
    switch (m.type) {
      case 'init':
        clearTimeout(s.helloTimer);
        s.reconnecting = false;
        view.setSettings(m.settings, { system: m.systemVoices, neural: m.neuralVoices });
        if (s.autoplay === false) { s.send('load', { sentences: s.doc.sentences, index: s.resumeAt }); view.setState('paused'); }
        else s.send('play', { sentences: s.doc.sentences, index: s.resumeAt });
        break;
      case 'settings': view.setSettings(m.settings); break;
      case 'state':
        view.setState(m.state, m.detail, m.progress);
        if (m.state === 'paused') pauseClock(s);
        else if (m.state === 'playing') resumeClock(s);
        else stopClock(s);
        break;
      case 'sentence':
        s.retries = 0;
        view.setSentence(m.index);
        stopClock(s);
        if (m.words) startClock(s, m); // natural voice: animate words locally from the timeline
        break;
      case 'hint':
        view.setHint(m.text, m.action);
        break;
      case 'word': // standard voices report real word boundaries
        if (m.index === view.active) view.setWord(m.index, m.charIndex, m.length);
        break;
    }
  }

  // Word clock for the natural voice: one message per sentence, then requestAnimationFrame does the rest.
  // rAF stops by itself when the tab is hidden, so a background tab costs nothing.
  function startClock(s, { index, duration, elapsed, words }) {
    const c = (s.clock = { index, duration, words, base: elapsed || 0, t0: performance.now(), raf: 0, last: -1, running: true });
    const frame = () => {
      if (s.clock !== c || !c.running) return;
      const frac = (c.base + (performance.now() - c.t0) / 1000) / c.duration;
      let w = c.last < 0 ? 0 : c.last;
      while (w + 1 < c.words.length && c.words[w + 1][2] <= frac) w++;
      if (w !== c.last) { c.last = w; s.view.setWord(c.index, c.words[w][0], c.words[w][1]); }
      if (frac < 1) c.raf = requestAnimationFrame(frame);
    };
    c.raf = requestAnimationFrame(frame);
  }
  function pauseClock(s) {
    const c = s.clock;
    if (!c || !c.running) return;
    c.running = false;
    cancelAnimationFrame(c.raf);
    c.base += (performance.now() - c.t0) / 1000;
  }
  function resumeClock(s) {
    const c = s.clock;
    if (!c || c.running) return;
    const old = c;
    stopClock(s);
    startClock(s, { index: old.index, duration: old.duration, elapsed: old.base, words: old.words });
  }
  function stopClock(s) {
    if (s.clock) cancelAnimationFrame(s.clock.raf);
    s.clock = null;
  }

  function close() {
    const s = session;
    if (!s) return;
    session = null;
    clearInterval(s.heartbeat);
    clearTimeout(s.helloTimer);
    stopClock(s);
    try { s.port.postMessage({ type: 'close' }); s.port.disconnect(); } catch {}
    s.view.destroy();
  }

  VX.reader = { open, close };
})();
