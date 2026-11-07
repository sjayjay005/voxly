// One reading session: a document model, the reader view, and a single Port to the service worker.
//
// Lifted out of the content script so the PDF and EPUB reader can use it unchanged — the only
// thing that differs between them is where the document model came from. Holds no state between
// sessions; closing drops the model, the view and the Port.
(() => {
  const VX = (globalThis.VX ||= {});
  if (VX.createSession) return;

  VX.createSession = function createSession(doc, { onClosed } = {}) {
    const s = {
      port: null, doc, view: null, clock: null, heartbeat: 0,
      resumeAt: doc.startAt || 0, retries: 0, closed: false
    };
    const send = (type, data = {}) => { try { s.port.postMessage({ type, ...data }); } catch {} };

    s.view = VX.createView(doc, {
      toggle() {
        const st = s.view.state;
        if (st === 'playing' || st === 'buffering') send('pause');
        else if (st === 'paused') send('resume');
        else send('play', { index: st === 'ended' ? 0 : Math.max(s.view.active, 0) });
      },
      seek(i) { if (i >= 0 && i < doc.sentences.length) send('play', { index: i }); },
      settings(patch) { send('settings', { patch }); },
      // What a hint's button does, by id. Keeping this here means a new hint needs no new wiring
      // in the view.
      hint(id) {
        if (id === 'handoff') send('settings', { patch: { handoff: true } });
        else if (id === 'nohandoff') send('settings', { patch: { handoff: false } });
        else if (id === 'natural-off') send('settings', { patch: { natural: false } });
        // 'dismiss' and anything unrecognised: closing the hint was the whole action.
      },
      close
    });
    s.view.setState('buffering', 'Getting ready');
    connect();
    // Chrome stops an idle extension service worker after ~30s. A slow machine can spend longer
    // than that generating one sentence, so keep the connection warm while the reader is open.
    s.heartbeat = setInterval(() => send('ping'), 20_000);

    function connect() {
      const port = chrome.runtime.connect({ name: 'voxly-reader' });
      s.port = port;
      port.onMessage.addListener((m) => onMessage(m));
      port.onDisconnect.addListener(() => reconnect(port));
      send('hello', { lang: doc.lang || document.documentElement.lang || navigator.language });
      // If a restarting service worker accepts the connection but never answers, try again.
      clearTimeout(s.helloTimer);
      s.helloTimer = setTimeout(() => {
        if (s.closed || s.port !== port) return;
        try { port.disconnect(); } catch {}
        reconnect(port);
      }, 5000);
    }

    // The service worker restarted (Chrome stops idle ones, and updates restart them). Reconnect
    // and carry on from the current sentence, playing again only if we were playing before.
    function reconnect(port) {
      if (s.closed || s.port !== port) return;
      s.port = null;
      stopClock();
      if (s.autoplay === undefined || !s.reconnecting) {
        s.autoplay = ['playing', 'buffering'].includes(s.view.state);
        s.resumeAt = Math.max(s.view.active, 0);
      }
      s.reconnecting = true;
      if (++s.retries > 4) { s.view.setState('error', 'Voxly lost its connection. Close the reader and open it again.'); return; }
      s.view.setState('buffering', 'Reconnecting');
      setTimeout(() => { if (!s.closed) connect(); }, 600 * s.retries);
    }

    function onMessage(m) {
      if (s.closed) return;
      const { view } = s;
      switch (m.type) {
        case 'init': {
          clearTimeout(s.helloTimer);
          s.reconnecting = false;
          view.setSettings(m.settings, { system: m.systemVoices, neural: m.neuralVoices });
          const article = { sentences: doc.sentences, blockStarts: doc.blockStarts, index: s.resumeAt };
          if (s.autoplay === false) { send('load', article); view.setState('paused'); }
          else send('play', article);
          break;
        }
        case 'settings': view.setSettings(m.settings); break;
        case 'state':
          view.setState(m.state, m.detail, m.progress);
          if (m.state === 'paused') pauseClock();
          else if (m.state === 'playing') resumeClock();
          else stopClock();
          break;
        case 'sentence':
          s.retries = 0;
          view.setSentence(m.index);
          stopClock();
          if (m.words) startClock(m); // natural voice: animate words locally from the timeline
          break;
        case 'hint': view.setHint(m.text, m.action, m.actionId); break;
        case 'word': // standard voices report real word boundaries
          if (m.index === view.active) view.setWord(m.index, m.charIndex, m.length);
          break;
      }
    }

    // Word clock for the natural voice: one message per sentence, then requestAnimationFrame does
    // the rest. rAF stops by itself when the tab is hidden, so a background tab costs nothing.
    function startClock({ index, duration, elapsed, words }) {
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
    function pauseClock() {
      const c = s.clock;
      if (!c || !c.running) return;
      c.running = false;
      cancelAnimationFrame(c.raf);
      c.base += (performance.now() - c.t0) / 1000;
    }
    function resumeClock() {
      const c = s.clock;
      if (!c || c.running) return;
      const old = c;
      stopClock();
      startClock({ index: old.index, duration: old.duration, elapsed: old.base, words: old.words });
    }
    function stopClock() {
      if (s.clock) cancelAnimationFrame(s.clock.raf);
      s.clock = null;
    }

    function close() {
      if (s.closed) return;
      s.closed = true;
      clearInterval(s.heartbeat);
      clearTimeout(s.helloTimer);
      stopClock();
      try { send('close'); s.port.disconnect(); } catch {}
      s.view.destroy();
      onClosed?.();
    }

    return { close, get view() { return s.view; } };
  };
})();
