// Natural-voice player. Works like a video player:
//   1. Generate sentences in a worker, measuring how fast this machine synthesizes (realtime factor, RTF).
//   2. Before starting, buffer enough audio that playback won't outrun generation (capped at ~30s of audio).
//   3. Play buffered sentences back-to-back on one AudioContext timeline (no gaps).
//   4. Keep at most AHEAD seconds generated ahead; free each sentence's audio as soon as it has played.
//   5. If generation ever falls behind, pause cleanly and show "Buffering" rather than stuttering.
//   6. After a minute with nothing to do, ask the service worker to close this document (frees the model).

const AHEAD = 45;              // seconds of audio to keep generated ahead of the playhead
const MAX_PREBUFFER = 30;      // never make you wait for more than ~30s of audio before starting
const REBUFFER = 8;            // after running dry, wait for this much audio before continuing
const CHARS_PER_SEC = 14.5;    // rough Kokoro speaking rate at 1×, used for estimates only
const SENTENCE_GAP = 0.06;     // breath between sentences
const IDLE_CLOSE_MS = 60_000;

// ---- worker RPC ----
const worker = new Worker('kokoro-worker.js');
const pending = new Map();
let rid = 0;
// The worker picks between its CPU and GPU engines by measuring them (see kokoro-worker.src.js). We keep its
// verdict so the next session starts on the right engine without measuring again.
let enginePref = chrome.storage.local.get('neuralEngine').then((r) => r.neuralEngine ?? null).catch(() => null);
worker.onmessage = ({ data }) => {
  if (data.type === 'engine') {
    enginePref = Promise.resolve({ engine: data.engine, adapter: data.adapter, rtf: data.rtf });
    chrome.storage.local.set({ neuralEngine: { engine: data.engine, adapter: data.adapter, rtf: data.rtf } }).catch(() => {});
    return;
  }
  // A download may also happen mid-article (the worker trying its other engine); only report it while we're
  // waiting anyway, never over audio that is playing fine.
  if (data.type === 'progress') return current && !current.started && emit('state', { state: 'buffering', detail: data.percent < 100 ? `Downloading natural voice (first time only)` : 'Loading natural voice', progress: data.percent / 100 });
  if (data.type === 'status') return current && emit('state', { state: 'buffering', detail: data.text });
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
};
function rpc(msg) {
  const id = ++rid;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id, baseUrl: chrome.runtime.getURL('') }); });
}
// Exposed so tests can substitute a fake synthesizer; production always uses the worker.
globalThis.voxlySynth = { generate: async (text, voice, speed) => rpc({ type: 'generate', text, voice, speed, pref: await enginePref }) };

// ---- messaging ----
let current = null; // the active session
const emit = (ev, data = {}) => chrome.runtime.sendMessage({ source: 'neural', ev, sid: current?.sid, ...data }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'neural') return;
  if (msg.op === 'start') start(msg);
  else if (!current || msg.sid !== current.sid) return;
  else if (msg.op === 'pause') pause();
  else if (msg.op === 'resume') resume();
  else if (msg.op === 'stop') stop();
});

// ---- audio ----
let ctx = null;
let idleTimer = null;

function start({ sid, sentences, from, voice, speed }) {
  stop();
  clearTimeout(idleTimer);
  ctx ||= new AudioContext({ latencyHint: 'playback', sampleRate: 24000 }); // Kokoro's native rate: no resampling
  ctx.resume();
  current = {
    sid, sentences, voice, speed,
    next: from,            // next sentence to generate
    ready: [],             // generated, not yet scheduled: {index, buffer, words}
    scheduled: [],         // scheduled on the timeline: {index, src, start, end, words, announced}
    timelineEnd: 0,
    rtf: null,             // audio seconds produced per wall-clock second (EMA)
    engine: null,          // 'cpu' | 'gpu': which worker engine produced the last sentence
    started: false,        // false while (re)buffering
    need: 0,               // seconds of audio required before (re)starting
    paused: false,
    generating: false,
    ticker: null
  };
  emit('state', { state: 'buffering', detail: 'Preparing natural voice', progress: 0 });
  pump(current);
}

const remainingChars = (s, from) => s.sentences.slice(from).reduce((n, t) => n + t.length, 0);
const readySeconds = (s) => s.ready.reduce((n, r) => n + r.buffer.duration, 0);
const aheadSeconds = (s) => readySeconds(s) + s.scheduled.reduce((n, it) => n + Math.max(0, it.end - ctx.currentTime), 0);
const allGenerated = (s) => s.next >= s.sentences.length;

// How much audio to buffer before playing so that playback never overtakes generation.
function prebufferNeeded(s, cap) {
  if (s.rtf == null) return Infinity;
  if (s.rtf >= 1.15) return 0; // faster than realtime: start as soon as the first sentence is ready
  const remainingAudio = remainingChars(s, s.next) / (CHARS_PER_SEC * s.speed) + readySeconds(s);
  return Math.min(cap, remainingAudio * (1 - s.rtf) + 2);
}

async function pump(s) {
  if (s.generating) return;
  s.generating = true;
  try {
    while (current === s && !allGenerated(s) && aheadSeconds(s) < AHEAD) {
      const index = s.next++;
      const text = s.sentences[index];
      const t0 = performance.now();
      const res = await globalThis.voxlySynth.generate(text, s.voice, s.speed);
      if (current !== s) return;
      const wall = (performance.now() - t0) / 1000;
      const buffer = ctx.createBuffer(1, res.audio.length, res.sampleRate);
      buffer.copyToChannel(res.audio, 0);
      // Prefer the worker's own measurement: it excludes model loading and smooths out warm-up, so the first
      // sentence no longer makes a fast machine wait for a 30s prebuffer. Wall-clock is the fallback (tests).
      const rtf = res.rtf ?? buffer.duration / Math.max(wall, 0.001);
      const engine = res.engine ?? null;
      s.rtf = s.rtf == null || engine !== s.engine ? rtf : s.rtf * 0.7 + rtf * 0.3; // a new engine: start over
      s.engine = engine;
      s.ready.push({ index, buffer, words: wordTimeline(text) });
      flush(s);
    }
  } catch (e) {
    if (current === s) { emit('state', { state: 'error', detail: 'The natural voice failed to load: ' + e.message }); stop(); }
  } finally {
    s.generating = false;
  }
  if (current === s) flush(s);
}

// Move ready audio onto the timeline once enough is buffered.
function flush(s) {
  if (!s.started) {
    const need = s.need || prebufferNeeded(s, MAX_PREBUFFER);
    const have = readySeconds(s);
    if (have < need && !allGenerated(s)) {
      const progress = need === Infinity ? 0 : have / need;
      const wait = need === Infinity ? '' : ` — about ${Math.ceil((need - have) / Math.max(s.rtf, 0.05))}s`;
      emit('state', { state: 'buffering', detail: `Preparing natural voice${wait}`, progress });
      return;
    }
    s.started = true;
    s.need = 0;
    s.timelineEnd = 0;
    if (!s.paused) { emit('state', { state: 'playing' }); startTicker(s); }
  }
  while (s.ready.length) schedule(s, s.ready.shift());
}

function schedule(s, item) {
  const src = ctx.createBufferSource();
  src.buffer = item.buffer;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.05, s.timelineEnd);
  src.start(start);
  const end = start + item.buffer.duration;
  const endsSentence = /[.!?…]["'”’)\]]?$/.test(s.sentences[item.index]);
  s.timelineEnd = end + (endsSentence ? SENTENCE_GAP : 0);
  const entry = { index: item.index, src, start, end, words: item.words, duration: item.buffer.duration, announced: false };
  s.scheduled.push(entry);
  src.onended = () => {
    // Release the audio as soon as it has played — this is what keeps memory flat on long articles.
    src.disconnect();
    src.buffer = null;
    const i = s.scheduled.indexOf(entry);
    if (i >= 0) s.scheduled.splice(i, 1);
    if (current !== s) return;
    if (!s.scheduled.length) {
      if (allGenerated(s) && !s.ready.length) { emit('state', { state: 'ended' }); stop(); return; }
      // Ran dry: generation is behind. Rebuffer instead of stuttering.
      s.started = false;
      s.need = Math.min(REBUFFER, remainingChars(s, s.next) / (CHARS_PER_SEC * s.speed));
      stopTicker(s);
      flush(s);
    }
    pump(s);
  };
}

// Announce each sentence when it actually starts playing, with its word timeline,
// so the reader can animate the highlight locally instead of us sending every word.
function startTicker(s) {
  stopTicker(s);
  s.ticker = setInterval(() => {
    if (current !== s) return stopTicker(s);
    const t = ctx.currentTime;
    for (const it of s.scheduled) {
      if (!it.announced && t >= it.start) {
        it.announced = true;
        emit('sentence', { index: it.index, duration: it.duration, elapsed: t - it.start, words: it.words });
      }
    }
  }, 50);
}
function stopTicker(s) { clearInterval(s.ticker); s.ticker = null; }

function pause() {
  const s = current;
  s.paused = true;
  ctx.suspend();
  stopTicker(s);
  emit('state', { state: 'paused' });
}

function resume() {
  const s = current;
  s.paused = false;
  ctx.resume();
  if (s.started) { startTicker(s); emit('state', { state: 'playing' }); }
  else flush(s);
}

function stop() {
  const s = current;
  current = null;
  if (s) {
    stopTicker(s);
    for (const it of s.scheduled) { it.src.onended = null; try { it.src.stop(); } catch {} it.src.disconnect(); it.src.buffer = null; }
    s.scheduled.length = 0;
    s.ready.length = 0;
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (current) return;
    ctx?.close(); ctx = null;
    chrome.runtime.sendMessage({ source: 'neural', ev: 'idle' }).catch(() => {});
  }, IDLE_CLOSE_MS);
}

// Kokoro has no word timestamps: spread words over the clip by length, weighting punctuation pauses.
function wordTimeline(text) {
  const words = [];
  let total = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0];
    words.push([m.index, w.length, total]);
    total += w.length + 1.5 + (/[.!?]["'”’)\]]?$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0);
  }
  // Kokoro pads a little silence at each end; fit the words into the middle of the clip.
  return words.map(([c, l, at]) => [c, l, 0.04 + (at / (total || 1)) * 0.9]);
}

// Read-only snapshot for debugging from the offscreen console (and the test suite).
globalThis.voxlyDebug = () => ({ active: !!current, ready: current?.ready.length ?? 0, scheduled: current?.scheduled.length ?? 0, rtf: current?.rtf ?? null, engine: current?.engine ?? null });
