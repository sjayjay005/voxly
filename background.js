// Voxly service worker: owns playback state and drives chrome.tts.

const DEFAULTS = { rate: 1, pitch: 1, voiceName: '', engine: 'chrome', kokoroVoice: 'af_heart' };
const MAX_CHUNK = 220; // Chrome voices can cut out on long utterances, so speak in small pieces.

let state = { chunks: [], index: 0, tabId: null, playing: false, paused: false, token: 0 };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'voxly-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'voxly-page', title: 'Read this page aloud', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'voxly-selection') startFromText(tab.id, info.selectionText || '');
  if (info.menuItemId === 'voxly-page') readTab(tab.id, 'page');
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'read-aloud' && tab?.id) readTab(tab.id, 'auto');
  if (command === 'toggle-pause') control('toggle');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'control') control(msg.action);
  else if (msg.type === 'read') readTab(msg.tabId, msg.mode || 'auto');
  else if (msg.type === 'readText') startFromText(msg.tabId, msg.text, 'Voice test');
  else if (msg.type === 'setRate') setRate(msg.rate, msg.delta);
  else if (msg.type === 'settingsChanged' && state.playing && !state.paused) restartChunk();
  else if (msg.type === 'kokoro:event') onKokoroEvent(msg);
  else if (msg.type === 'kokoro:preload') ensureOffscreen().then(() => toOffscreen({ type: 'preload' }));
  else if (msg.type === 'getState') {
    sendResponse({ playing: state.playing, paused: state.paused, index: state.index, total: state.chunks.length });
  }
  return false;
});

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['Readability.js', 'content.js'] });
}

async function readTab(tabId, mode) {
  try {
    await ensureContent(tabId);
    const res = await chrome.tabs.sendMessage(tabId, { type: 'voxly:extract', mode });
    await startFromText(tabId, res?.text || '', res?.title);
  } catch (e) {
    // Chrome pages (chrome://, Web Store) block scripts; nothing we can do there.
    console.warn('Voxly could not read this tab:', e);
  }
}

function chunkText(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = [];
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
    for (const s of seg.segment(clean)) sentences.push(s.segment.trim());
  } catch {
    sentences.push(...clean.split(/(?<=[.!?])\s+/));
  }
  const pieces = [];
  for (const s of sentences.filter(Boolean)) {
    if (s.length <= MAX_CHUNK) { pieces.push(s); continue; }
    // Split long sentences at commas/semicolons, then at spaces.
    let rest = s;
    while (rest.length > MAX_CHUNK) {
      let cut = Math.max(rest.lastIndexOf(', ', MAX_CHUNK), rest.lastIndexOf('; ', MAX_CHUNK));
      if (cut < MAX_CHUNK / 2) cut = rest.lastIndexOf(' ', MAX_CHUNK);
      if (cut <= 0) cut = MAX_CHUNK;
      pieces.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) pieces.push(rest);
  }
  // Merge tiny neighbours so playback doesn't stutter between short sentences.
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.length + p.length + 1 <= MAX_CHUNK && last.length < 60) merged[merged.length - 1] = last + ' ' + p;
    else merged.push(p);
  }
  return merged;
}

async function startFromText(tabId, text, title) {
  const chunks = chunkText(text);
  if (!chunks.length) return;
  stopEngines();
  state = { chunks, index: 0, tabId, playing: true, paused: false, token: state.token + 1 };
  try { await ensureContent(tabId); } catch {}
  const { rate, engine } = await getSettings();
  notify('open', { chunks, title: title || '', rate, engine });
  speakCurrent();
}

async function speakCurrent() {
  const { rate, pitch, voiceName, engine, kokoroVoice } = await getSettings();
  const token = state.token;
  const i = state.index;
  if (i >= state.chunks.length) return finish();
  notify('chunk', { index: i });
  updateBadge();
  state.engine = engine;

  if (engine === 'kokoro') {
    await ensureOffscreen();
    if (token !== state.token) return;
    toOffscreen({ type: 'speak', token, index: i, text: state.chunks[i], nextText: state.chunks[i + 1] || '',
                  voice: kokoroVoice, speed: Number(rate) || 1 });
    return;
  }

  const opts = {
    rate: Number(rate) || 1,
    pitch: Number(pitch) || 1,
    enqueue: false,
    onEvent: (e) => {
      if (token !== state.token || i !== state.index) return; // stale utterance
      if (e.type === 'word') notify('word', { index: i, charIndex: e.charIndex, length: e.length });
      else if (e.type === 'end') { state.index++; speakCurrent(); }
      else if (e.type === 'error') { notify('error', { message: e.errorMessage || 'Voice error' }); stop(); }
    }
  };
  if (voiceName) opts.voiceName = voiceName;
  chrome.tts.speak(state.chunks[i], opts);
}

function restartChunk() {
  state.token++;
  stopEngines();
  speakCurrent();
}

function stopEngines() {
  chrome.tts.stop();
  toOffscreen({ type: 'stop' });
}

// ---- Kokoro (neural) engine, hosted in an offscreen document ----
let creatingOffscreen = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'], // not AUDIO_PLAYBACK: that reason auto-closes the doc after 30s of silence and would drop the loaded model
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
  if (e.token !== state.token || e.index !== state.index) return; // stale
  if (e.event === 'start') notify('loading', { done: true });
  else if (e.event === 'word') notify('word', { index: e.index, charIndex: e.charIndex, length: e.length });
  else if (e.event === 'end') { state.index++; speakCurrent(); }
  else if (e.event === 'error') { notify('error', { message: e.message }); stop(); }
}

function control(action) {
  if (!state.playing) return;
  switch (action) {
    case 'toggle': return state.paused ? control('resume') : control('pause');
    case 'pause':
      if (state.engine === 'kokoro') toOffscreen({ type: 'pause' }); else chrome.tts.pause();
      state.paused = true; break;
    case 'resume':
      state.paused = false;
      if (state.engine === 'kokoro') { toOffscreen({ type: 'resume' }); break; }
      // Some online voices ignore resume, so re-speak the current chunk if nothing is playing.
      chrome.tts.resume();
      setTimeout(() => chrome.tts.isSpeaking((s) => { if (!s && state.playing && !state.paused) restartChunk(); }), 300);
      break;
    case 'next':
    case 'prev':
      state.index = Math.min(Math.max(state.index + (action === 'next' ? 1 : -1), 0), state.chunks.length - 1);
      state.paused = false; restartChunk(); break;
    case 'stop':
      return stop();
  }
  notify('state', { paused: state.paused });
  updateBadge();
}

async function setRate(rate, delta) {
  const cur = await getSettings();
  let r = rate != null ? Number(rate) : Number(cur.rate) + Number(delta || 0);
  r = Math.round(Math.min(Math.max(r, 0.5), 3) * 10) / 10;
  await chrome.storage.sync.set({ rate: r });
  notify('rate', { rate: r });
  if (state.playing && !state.paused) restartChunk();
}

function stop() {
  state.token++;
  stopEngines();
  const tabId = state.tabId;
  state = { ...state, playing: false, paused: false, chunks: [], index: 0 };
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'voxly:close' }).catch(() => {});
  updateBadge();
}

function finish() { stop(); }

function notify(kind, payload) {
  if (!state.tabId) return;
  chrome.tabs.sendMessage(state.tabId, { type: 'voxly:' + kind, ...payload }).catch(() => {});
}

function updateBadge() {
  const text = !state.playing ? '' : state.paused ? '❚❚' : '▶';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#6D4AFF' });
}
