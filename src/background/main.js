// Service worker: opens the reader and owns the single reading session.
// The reader (content script) talks to us over a Port; when the tab closes or navigates, the Port
// disconnects and everything is torn down — no orphaned audio, no lingering state.
import { createSystemEngine } from './system-engine.js';
import { createNeuralEngine } from './neural-engine.js';
import { createHybridEngine } from './hybrid-engine.js';
import { NEURAL_VOICES, DEFAULT_SETTINGS } from './voices.js';

const READER_FILES = ['lib/Readability.js', 'src/doc/model.js', 'src/doc/session.js',
                      'src/reader/extract.js', 'src/reader/view.js', 'src/reader/reader.js'];

/** @type {{port: chrome.runtime.Port, sentences: string[], blockStarts: number[], index: number, state: string, engine: object} | null} */
let session = null;

const emit = (type, data) => {
  if (!session) return;
  if (type === 'sentence') session.index = data.index;
  if (type === 'state') session.state = data.state;
  try { session.port.postMessage({ type, ...data }); } catch {}
};

// The hybrid engine needs to know which engine an event came from — it follows the system
// voice's progress while the natural one generates. Everything still reaches the reader.
const taps = new Set();
const tap = (fn) => { taps.add(fn); return () => taps.delete(fn); };
const emitFrom = (who) => (type, data) => {
  for (const fn of [...taps]) fn(who, type, data);
  emit(type, data);
};

const engines = {
  system: createSystemEngine(emitFrom('system')),
  neural: createNeuralEngine(emitFrom('neural'))
};
engines.hybrid = createHybridEngine(emit, { system: engines.system, neural: engines.neural, tap });

const getSettings = () => chrome.storage.sync.get(DEFAULT_SETTINGS);

const VIEWER = 'src/viewer/viewer.html';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'voxly-read', title: 'Read this page with Voxly', contexts: ['page', 'selection'] });
    // On the toolbar icon, because it is about no page in particular.
    chrome.contextMenus.create({ id: 'voxly-open-file', title: 'Read a PDF with Voxly\u2026', contexts: ['action'] });
  });
});

const openViewer = () => chrome.tabs.create({ url: chrome.runtime.getURL(VIEWER) });

chrome.action.onClicked.addListener((tab) => openReader(tab));
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'voxly-open-file') openViewer();
  else openReader(tab);
});

async function openReader(tab) {
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: READER_FILES });
    await chrome.tabs.sendMessage(tab.id, { type: 'voxly:toggle' });
  } catch (e) {
    // chrome:// pages, the Web Store and Chrome's own PDF viewer don't allow extensions to run.
    // We cannot fetch the PDF ourselves without host permissions, so point at the file reader,
    // where someone can open their own copy.
    if (/\.pdf(?:[?#]|$)/i.test(tab.url || '')) {
      badgeUnreadable(tab.id, "Chrome blocks extensions on its PDF viewer \u2014 right-click the Voxly icon for the file reader");
    } else {
      badgeUnreadable(tab.id);
    }
  }
}

// Flash '!' on the toolbar icon. This is the only feedback channel we have when there is no
// reader on screen to put a message in.
function badgeUnreadable(tabId, title = "Voxly can't read this page") {
  if (tabId == null) return;
  chrome.action.setBadgeText({ tabId, text: '!' });
  chrome.action.setTitle({ tabId, title });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 3000);
}

// The reader ran but found nothing worth reading. It has no UI up at that point, so it asks us
// to badge the icon rather than interrupting the page with a dialog.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'voxly:unreadable') badgeUnreadable(sender.tab?.id, 'Voxly found no text to read on this page');
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'voxly-reader') return;
  endSession(); // one reader at a time
  session = { port, sentences: [], blockStarts: [], index: 0, state: 'idle', engine: null };
  const mine = session;
  port.onMessage.addListener((msg) => { if (session === mine) handle(msg); });
  port.onDisconnect.addListener(() => { if (session === mine) endSession(); });
});

async function handle(msg) {
  switch (msg.type) {
    case 'ping': break; // heartbeat from the reader; receiving it keeps this worker alive
    case 'hello': {
      const [settings, voices] = await Promise.all([getSettings(), chrome.tts.getVoices()]);
      emit('init', { settings, systemVoices: rankVoices(voices, msg.lang), neuralVoices: NEURAL_VOICES });
      break;
    }
    case 'load': // reconnected while paused: remember the article without starting playback
      session.sentences = msg.sentences;
      session.blockStarts = msg.blockStarts || [];
      session.index = msg.index;
      session.state = 'paused';
      break;
    case 'play':
      if (msg.sentences) session.sentences = msg.sentences;
      if (msg.blockStarts) session.blockStarts = msg.blockStarts;
      await play(msg.index ?? session.index);
      break;
    case 'pause': session.engine?.pause(); break;
    case 'resume': session.engine?.resume(() => play(session.index)); break;
    case 'settings': {
      const next = { ...(await getSettings()), ...msg.patch };
      await chrome.storage.sync.set(next);
      emit('settings', { settings: next });
      if (session.state !== 'playing' && session.state !== 'buffering') break;
      // A speed change alone never restarts the natural voice: it keeps playing what it has and
      // re-generates in the background. Anything else (voice, engine) has to start over.
      const patched = Object.keys(msg.patch);
      const rateOnly = patched.length === 1 && patched[0] === 'rate';
      if (rateOnly && session.engine?.rate) session.engine.rate(next.rate);
      else await play(session.index);
      break;
    }
    case 'close': endSession(); break;
  }
}

// Best voices first: the page's language, then Apple's Premium/Enhanced and other natural-sounding voices.
function rankVoices(voices, lang = navigator.language) {
  const base = (lang || 'en').slice(0, 2).toLowerCase();
  const quality = (n) => (/premium/i.test(n) ? 3 : /enhanced|natural|neural/i.test(n) ? 2 : /^google/i.test(n) ? 1 : 0);
  return voices.filter((v) => v.voiceName)
    .map((v) => ({ id: v.voiceName, label: v.voiceName + (v.remote ? ' (online)' : ''), lang: v.lang || '',
                   score: ((v.lang || '').toLowerCase().startsWith(base) ? 10 : 0) + quality(v.voiceName) }))
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .map(({ score, ...v }) => v);
}

/**
 * Which engine reads this. The hybrid engine is the default for the natural voice: it starts in
 * the system voice and changes over when the natural one is ready, which on a slow machine is the
 * difference between speaking at once and waiting the better part of a minute. Turning off
 * `handoff` goes straight to the natural voice and waits for it.
 */
function pickEngine(settings) {
  if (!settings.natural) return engines.system;
  return settings.handoff ? engines.hybrid : engines.neural;
}

async function play(index) {
  const settings = await getSettings();
  const engine = pickEngine(settings);
  for (const e of Object.values(engines)) if (e !== engine) e.stop();
  session.engine = engine;
  session.index = Math.max(0, Math.min(index, session.sentences.length - 1));
  emit('sentence', { index: session.index });
  await engine.start(session.sentences, session.index, settings, { blockStarts: session.blockStarts });
}

function endSession() {
  if (!session) return;
  for (const e of Object.values(engines)) e.stop();
  try { session.port.disconnect(); } catch {}
  session = null;
}
