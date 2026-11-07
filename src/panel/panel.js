// The side panel: a player that outlives the page it started from.
//
// The reader overlay lives in a tab and dies with it. This panel is a second client of the same
// reading session, so switching tabs or closing the one you started from no longer stops the
// audio — and while it is open its heartbeat keeps the service worker alive, which is what lets
// playback carry on at all.
//
// It holds no copy of the document: the service worker sends the title, the position and the
// sentence currently being spoken.
const SPEEDS = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const fmtSpeed = (r) => (Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2))) + '\u00d7';

const el = (id) => document.getElementById(id);
const ui = {
  empty: el('empty'), player: el('player'), title: el('title'), where: el('where'),
  saying: el('saying'), fill: el('fill'), toggle: el('toggle'), prev: el('prev'), next: el('next'),
  natural: el('natural'), rate: el('rate'), slower: el('slower'), faster: el('faster'), stop: el('stop'),
  queue: el('queue'), qlist: el('qlist'), clear: el('clear'), qhow: el('qhow')
};

const AGO = [[86400, 'd'], [3600, 'h'], [60, 'm']];
/** "3h ago", or "just now" under a minute. */
function ago(at) {
  const secs = Math.max(0, (Date.now() - at) / 1000);
  for (const [span, unit] of AGO) if (secs >= span) return `${Math.floor(secs / span)}${unit} ago`;
  return 'just now';
}

let port = null;
let state = 'idle';
let index = 0;
let total = 0;
let rate = 1;
let heartbeat = 0;

const send = (type, data = {}) => { try { port?.postMessage({ type, ...data }); } catch {} };

function connect() {
  port = chrome.runtime.connect({ name: 'voxly-panel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    keepAlive(false);
    // The worker was stopped, or nothing is reading. Reconnect so we notice when it starts again.
    setTimeout(connect, 800);
  });
  send('hello', { lang: navigator.language });
}

/**
 * Chrome stops an idle service worker after ~30s, and a heartbeat is what keeps the session
 * alive while you browse away. Only beat while something is playing: an open panel with nothing
 * to read has no business holding the worker resident.
 */
function keepAlive(on) {
  clearInterval(heartbeat);
  heartbeat = on ? setInterval(() => send('ping'), 20_000) : 0;
}

function onMessage(m) {
  switch (m.type) {
    case 'init':
      applySettings(m.settings);
      renderQueue(m.queue || []);
      if (m.snapshot) applySnapshot(m.snapshot);
      else show(null);
      break;
    case 'queue': renderQueue(m.items || []); break;
    case 'settings': applySettings(m.settings); break;
    case 'state':
      state = m.state;
      keepAlive(state === 'playing' || state === 'buffering');
      if (m.state === 'idle') show(null);
      else render();
      break;
    case 'sentence':
      index = m.index;
      if (m.text != null) ui.saying.textContent = m.text;
      render();
      break;
  }
}

function applySnapshot(s) {
  total = s.total;
  index = s.index;
  state = s.state;
  keepAlive(state === 'playing' || state === 'buffering');
  ui.title.textContent = s.title || 'Reading';
  ui.saying.textContent = s.text || '';
  show(s);
}

function applySettings(s) {
  if (!s) return;
  rate = Number(s.rate) || 1;
  ui.rate.textContent = fmtSpeed(rate);
  ui.natural.checked = !!s.natural;
}

/** `null` means nothing is reading. */
/** `null` means nothing is reading. The queue stays visible either way — it is the point of it. */
function show(s) {
  const live = !!s;
  ui.player.hidden = !live;
  ui.empty.hidden = live;
  if (live) render();
}

function render() {
  if (state !== 'idle') { ui.player.hidden = false; ui.empty.hidden = true; }
  ui.where.textContent = total ? `Sentence ${index + 1} of ${total}` : '';
  ui.fill.style.width = total ? `${((index + 1) / total) * 100}%` : '0';
  const playing = state === 'playing' || state === 'buffering';
  ui.toggle.textContent = state === 'buffering' ? 'Getting ready\u2026'
    : playing ? 'Pause'
    : state === 'ended' ? 'Read again'
    : 'Play';
  ui.toggle.disabled = state === 'buffering';
  ui.prev.disabled = index <= 0;
  ui.next.disabled = total ? index >= total - 1 : true;
}

/**
 * The list of things waiting. Each entry carries its own sentences in storage, so playing one
 * needs nothing from the page it came from — which is the point: the tab is long gone.
 */
function renderQueue(items) {
  ui.queue.hidden = !items.length;
  ui.qhow.hidden = items.length > 0;
  ui.qlist.replaceChildren(...items.map((it) => {
    const li = document.createElement('li');

    const play = document.createElement('button');
    play.className = 'item';
    play.title = `Read "${it.title}"`;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = it.title;
    const m = document.createElement('span');
    m.className = 'm';
    m.textContent = [it.site, `${it.count} sentences`, ago(it.addedAt)].filter(Boolean).join(' \u00b7 ');
    play.append(t, m);
    play.addEventListener('click', () => send('queue-play', { id: it.id }));

    const x = document.createElement('button');
    x.className = 'x';
    x.title = `Remove "${it.title}"`;
    x.textContent = '\u2715';
    x.addEventListener('click', () => send('queue-remove', { id: it.id }));

    li.append(play, x);
    return li;
  }));
}

ui.clear.addEventListener('click', () => send('queue-clear'));

ui.toggle.addEventListener('click', () => {
  if (state === 'playing') send('pause');
  else if (state === 'paused') send('resume');
  else send('play', { index: state === 'ended' ? 0 : index });
});
ui.prev.addEventListener('click', () => send('play', { index: Math.max(0, index - 1) }));
ui.next.addEventListener('click', () => send('play', { index: index + 1 }));
ui.natural.addEventListener('change', () => send('settings', { patch: { natural: ui.natural.checked } }));
ui.stop.addEventListener('click', () => { send('stop'); keepAlive(false); show(null); });

for (const [btn, dir] of [[ui.slower, -1], [ui.faster, 1]]) {
  btn.addEventListener('click', () => {
    let i = SPEEDS.findIndex((s) => s >= rate - 0.001);
    if (i < 0) i = SPEEDS.length - 1;
    const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + dir))];
    if (next !== rate) send('settings', { patch: { rate: next } });
  });
}

connect();
