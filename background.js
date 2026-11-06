// Voxly service worker: owns the reading session and drives the two engines.
//  - Standard: chrome.tts with every sentence queued up front (no gaps between sentences).
//  - Neural:   Kokoro in an offscreen document that generates ahead and schedules audio back-to-back.

const DEFAULTS = { rate: 1, pitch: 1, voiceName: '', engine: 'chrome', kokoroVoice: 'af_heart' };
const LIMIT = { chrome: 220, kokoro: 320 }; // online Chrome voices cut out on long utterances; Kokoro is happy with full sentences

let state = { chunks: [], starts: [], index: 0, tabId: null, playing: false, paused: false, token: 0, engine: 'chrome' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'voxly-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'voxly-page', title: 'Read this page aloud', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  readTab(tab.id, info.menuItemId === 'voxly-selection' ? 'selection' : 'page', info.selectionText);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'read-aloud' && tab?.id) readTab(tab.id, 'auto');
  if (command === 'toggle-pause') control('toggle');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'control': control(msg.action, msg); break;
    case 'read': readTab(msg.tabId, msg.mode || 'auto'); break;
    case 'readText': startFromText(msg.tabId, msg.text, msg.title || 'Voice test'); break;
    case 'setRate': setRate(msg.rate, msg.delta); break;
    case 'settingsChanged': if (state.playing && !state.paused) restart(); break;
    case 'kokoro:event': onKokoroEvent(msg); break;
    case 'kokoro:preload': ensureOffscreen().then(() => toOffscreen({ type: 'preload' })); break;
    case 'getState':
      sendResponse({ playing: state.playing, paused: state.paused, index: state.index, total: state.chunks.length });
      break;
  }
  return false;
});

const getSettings = () => chrome.storage.sync.get(DEFAULTS);

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['Readability.js', 'content.js'] });
}

async function readTab(tabId, mode, fallbackText) {
  try {
    await ensureContent(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { type: 'voxly:extract', mode });
    const text = res?.text || fallbackText || '';
    await startFromText(tabId, text, res?.title);
  } catch (e) {
    // chrome:// pages, the Web Store and PDFs block scripts. Fall back to what the context menu gave us.
    if (fallbackText) startFromText(tabId, fallbackText, '', true);
    else console.warn('Voxly could not read this tab:', e);
  }
}

// ---- Chunking: sentence-aligned ranges into the normalized text ----
// Each chunk is an exact slice of `clean`, so chunk offsets map straight back to the page for highlighting.
function chunkText(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const ranges = [];
  const push = (a, b) => { while (clean[a] === ' ') a++; while (b > a && clean[b - 1] === ' ') b--; if (b > a) ranges.push([a, b]); };
  let segs;
  try { segs = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(clean)].map((s) => [s.index, s.index + s.segment.length]); }
  catch { segs = []; let last = 0; for (const m of clean.matchAll(/[.!?]+\s/g)) { segs.push([last, m.index + m[0].length]); last = m.index + m[0].length; } segs.push([last, clean.length]); }

  for (let [a, b] of segs) {
    // Only very long sentences get split; prefer clause boundaries so intonation survives.
    while (b - a > max) {
      const win = clean.slice(a, a + max);
      let cut = Math.max(win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(' — '), win.lastIndexOf(', '));
      if (cut < max * 0.4) cut = win.lastIndexOf(' ');
      if (cut <= 0) cut = max - 1;
      push(a, a + cut + 1);
      a = a + cut + 1;
    }
    push(a, b);
  }
  // Glue very short sentences onto their neighbour ("Yes." "Okay.") so they don't sound clipped.
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && (last[1] - last[0] < 40 || r[1] - r[0] < 25) && r[1] - last[0] <= max) last[1] = r[1];
    else merged.push([...r]);
  }
  return { chunks: merged.map(([a, b]) => clean.slice(a, b)), starts: merged.map(([a]) => a) };
}

// Neural voices synthesize a chunk before it plays, so make the very first one short — at a clause boundary.
function shortenFirst(chunks, starts) {
  const first = chunks[0];
  if (first.length <= 140) return;
  const win = first.slice(0, 120);
  const cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(': '), win.lastIndexOf(' — '));
  if (cut < 40) return; // no natural pause early on — keep the whole sentence rather than cut mid-phrase
  chunks.splice(0, 1, first.slice(0, cut + 1), first.slice(cut + 2));
  starts.splice(0, 1, starts[0], starts[0] + cut + 2);
}

async function startFromText(tabId, text, title, unmapped) {
  const s = await getSettings();
  const { chunks, starts } = chunkText(text, LIMIT[s.engine] || 220);
  if (!chunks.length) return;
  if (s.engine === 'kokoro') shortenFirst(chunks, starts);
  stopEngines();
  state = { chunks, starts, index: 0, tabId, playing: true, paused: false, token: state.token + 1, engine: s.engine };
  try { await ensureContent(tabId); } catch {}
  notify('open', { chunks, starts, title: title || '', rate: s.rate, engine: s.engine,
                   voice: s.engine === 'kokoro' ? s.kokoroVoice : (s.voiceName || 'System voice'), unmapped: !!unmapped });
  play();
}

async function play() {
  const s = await getSettings();
  const token = state.token;
  const from = state.index;
  if (from >= state.chunks.length) return stop();
  state.engine = s.engine;
  notify('chunk', { index: from });
  updateBadge();

  if (s.engine === 'kokoro') {
    await ensureOffscreen();
    if (token !== state.token) return;
    toOffscreen({ type: 'play', token, chunks: state.chunks, startIndex: from, voice: s.kokoroVoice, speed: Number(s.rate) || 1 });
    return;
  }

  // Standard engine: queue everything now. Chrome plays the queue back-to-back with no round trips.
  const opts = { rate: Number(s.rate) || 1, pitch: Number(s.pitch) || 1 };
  if (s.voiceName) opts.voiceName = s.voiceName;
  const last = state.chunks.length - 1;
  for (let j = from; j <= last; j++) {
    chrome.tts.speak(state.chunks[j], {
      ...opts,
      enqueue: j > from,
      onEvent: (e) => {
        if (token !== state.token) return;
        if (e.type === 'start' && state.index !== j) { state.index = j; notify('chunk', { index: j }); }
        else if (e.type === 'word') { if (state.index !== j) { state.index = j; notify('chunk', { index: j }); } notify('word', { index: j, charIndex: e.charIndex, length: e.length }); }
        else if (e.type === 'end' && j === last) stop();
        else if (e.type === 'error') fail(e.errorMessage || 'Voice error');
      }
    });
  }
}

function restart() {
  state.token++;
  stopEngines();
  play();
}

function stopEngines() {
  chrome.tts.stop();
  toOffscreen({ type: 'stop' });
}

function control(action, msg = {}) {
  if (!state.playing) return;
  switch (action) {
    case 'toggle': return control(state.paused ? 'resume' : 'pause');
    case 'pause':
      if (state.engine === 'kokoro') toOffscreen({ type: 'pause' }); else chrome.tts.pause();
      state.paused = true; break;
    case 'resume':
      state.paused = false;
      if (state.engine === 'kokoro') { toOffscreen({ type: 'resume' }); break; }
      chrome.tts.resume();
      // Some online voices ignore resume — restart the current sentence if nothing came back.
      setTimeout(() => chrome.tts.isSpeaking((sp) => { if (!sp && state.playing && !state.paused) restart(); }), 300);
      break;
    case 'next': case 'prev': case 'seek': {
      const target = action === 'seek' ? Number(msg.index) : state.index + (action === 'next' ? 1 : -1);
      state.index = Math.min(Math.max(target, 0), state.chunks.length - 1);
      state.paused = false;
      restart();
      break;
    }
    case 'stop': return stop();
  }
  notify('state', { paused: state.paused });
  updateBadge();
}

async function setRate(rate, delta) {
  const cur = await getSettings();
  let r = rate != null ? Number(rate) : Number(cur.rate) + Number(delta || 0);
  r = Math.round(Math.min(Math.max(r, 0.5), 3) * 20) / 20;
  await chrome.storage.sync.set({ rate: r });
  notify('rate', { rate: r });
  if (state.playing && !state.paused) restart();
}

function stop() {
  state.token++;
  stopEngines();
  const tabId = state.tabId;
  state = { ...state, playing: false, paused: false, chunks: [], starts: [], index: 0 };
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'voxly:close' }).catch(() => {});
  updateBadge();
}

function fail(message) {
  state.token++;
  stopEngines();
  notify('error', { message });
  state = { ...state, playing: false, paused: false };
  updateBadge();
}

// ---- Neural engine (offscreen document) ----
let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'], // not AUDIO_PLAYBACK: that auto-closes after 30s of silence and would drop the loaded model
      justification: 'Runs the on-device neural text-to-speech model in a worker and plays its audio.'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function toOffscreen(msg) {
  chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

function onKokoroEvent(e) {
  if (e.event === 'progress') return notify('loading', { percent: e.percent });
  if (e.event === 'status') return notify('loading', { text: e.text });
  if (e.token !== state.token) return; // stale session
  if (e.event === 'chunk') { state.index = e.index; notify('loading', { done: true }); notify('chunk', { index: e.index }); }
  else if (e.event === 'word') notify('word', { index: e.index, charIndex: e.charIndex, length: e.length });
  else if (e.event === 'done') stop();
  else if (e.event === 'error') fail(e.message);
}

function notify(kind, payload) {
  if (!state.tabId) return;
  chrome.tabs.sendMessage(state.tabId, { type: 'voxly:' + kind, ...payload }).catch(() => {});
}

function updateBadge() {
  chrome.action.setBadgeText({ text: !state.playing ? '' : state.paused ? '❚❚' : '▶' });
  chrome.action.setBadgeBackgroundColor({ color: '#6D4AFF' });
}
