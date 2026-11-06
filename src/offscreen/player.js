// Natural-voice player. Two independent loops, like a video player with a download manager:
//
//   generator: synthesizes every sentence of the article in order (in a worker) and saves it to the
//              local audio cache. Sentences already cached are skipped, so replays and resumes are instant.
//              It measures this machine's speed (realtime factor, RTF = audio seconds per wall second).
//   player:    keeps only ~30s of decoded audio in memory, scheduled back-to-back on one AudioContext
//              timeline, and frees each clip as soon as it has played.
//
// Before starting, it buffers enough audio that playback won't overtake generation (capped), and if it
// ever runs dry it shows "Buffering" instead of stuttering. A minute after you stop, it asks the service
// worker to close this document, which releases the model's memory.
import { AudioCache } from './audio-cache.js';

const MEM_AHEAD = 30;          // seconds of audio decoded/scheduled ahead of the playhead
const MAX_PREBUFFER = 60;      // longest initial buffer, in seconds of audio
const MAX_WAIT = 45;           // ...and never ask you to wait more than ~45s of wall-clock time for it
const SLOW_RTF = 0.5;          // below this, suggest the standard voice
const REBUFFER = 10;           // after running dry, wait for this much audio before continuing
const CHARS_PER_SEC = 14.5;    // rough Kokoro speaking rate at 1×, for estimates only
const SENTENCE_GAP = 0.06;
const IDLE_CLOSE_MS = 60_000;

const cache = new AudioCache();
// This machine's synthesis speed, remembered across sessions so a cached article can start immediately.
const savedRtf = () => { const v = Number(localStorage.getItem('voxly.rtf')); return v > 0 ? v : null; };
// Ask Chrome to keep this extension's storage (model weights + audio cache) under storage pressure.
navigator.storage?.persist?.().catch(() => {});

// ---- worker RPC ----
const worker = new Worker('kokoro-worker.js');
const pending = new Map();
let rid = 0;
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    if (current) emit('state', { state: 'buffering', detail: data.percent < 100 ? 'Downloading natural voice (one time only)' : 'Loading natural voice', progress: data.percent / 100 });
    return;
  }
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
globalThis.voxlySynth = { generate: (text, voice, speed) => rpc({ type: 'generate', text, voice, speed }) };

// ---- messaging ----
let current = null;
const emit = (ev, data = {}) => chrome.runtime.sendMessage({ source: 'neural', ev, sid: current?.sid, ...data }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'neural') return;
  if (msg.op === 'start') start(msg);
  else if (!current || msg.sid !== current.sid) return;
  else if (msg.op === 'pause') pause();
  else if (msg.op === 'resume') resume();
  else if (msg.op === 'stop') stop();
});

let ctx = null;
let idleTimer = null;

async function start({ sid, sentences, from, voice, speed }) {
  stop();
  clearTimeout(idleTimer);
  ctx ||= new AudioContext({ latencyHint: 'playback', sampleRate: 24000 }); // Kokoro's native rate
  ctx.resume();
  const s = (current = {
    sid, sentences, voice, speed, from,
    keys: [], dur: new Map(), avail: new Set(), fresh: new Map(),
    genNext: from, playNext: from, scheduled: [], timelineEnd: 0,
    rtf: savedRtf(), started: false, need: 0, paused: false, filling: false, ticker: null
  });
  emit('state', { state: 'buffering', detail: 'Preparing natural voice', progress: null });

  try {
    s.keys = await Promise.all(sentences.map((t) => AudioCache.key(voice, speed, t)));
    const known = await cache.lookup(s.keys.slice(from));
    s.keys.forEach((k, i) => { if (i >= from && known.has(k)) { s.avail.add(i); s.dur.set(i, known.get(k)); } });
  } catch (e) { console.warn('[voxly] audio cache unavailable', e); }
  if (current !== s) return;
  flush(s);
  generate(s);
}

const est = (s, i) => s.dur.get(i) ?? s.sentences[i].length / (CHARS_PER_SEC * s.speed);
function contiguousSeconds(s) {
  let t = 0;
  for (let i = s.playNext; i < s.sentences.length && s.avail.has(i); i++) t += s.dur.get(i);
  return t;
}
const restAvailable = (s) => { for (let i = s.playNext; i < s.sentences.length; i++) if (!s.avail.has(i)) return false; return true; };

// How much audio to buffer before playing so that playback never overtakes generation.
function prebufferNeeded(s, cap) {
  if (restAvailable(s)) return 0;
  if (s.rtf == null) return Infinity;
  let missing = 0, nextMissing = 0;
  for (let i = s.playNext; i < s.sentences.length; i++) {
    if (s.avail.has(i)) continue;
    if (!nextMissing) nextMissing = est(s, i);
    missing += est(s, i);
  }
  const lead = nextMissing / s.rtf + 0.5;             // cover the time it takes to make the next sentence
  if (s.rtf >= 1.15) return Math.min(cap, lead);
  const seamless = missing * (1 - s.rtf) + 2;       // enough to never run dry
  const patience = Math.max(s.rtf * MAX_WAIT, est(s, s.playNext)); // what we can make in ~MAX_WAIT
  return Math.min(cap, Math.max(seamless, lead), Math.max(patience, lead));
}

// ---- generator: whole article, into the cache ----
async function generate(s) {
  if (s.generating) return;
  s.generating = true;
  try {
    for (; s.genNext < s.sentences.length; s.genNext++) {
      if (current !== s) return;
      const i = s.genNext;
      if (s.avail.has(i)) continue;
      const t0 = performance.now();
      const res = await globalThis.voxlySynth.generate(s.sentences[i], s.voice, s.speed);
      if (current !== s) return;
      const dur = res.audio.length / res.sampleRate;
      const rtf = dur / Math.max((performance.now() - t0) / 1000, 0.001);
      s.rtf = s.rtf == null ? rtf : s.rtf * 0.7 + rtf * 0.3;
      try { localStorage.setItem('voxly.rtf', String(s.rtf)); } catch {}
      // Keep the raw audio in memory only if it's about to play; everything else lives in the cache.
      if (i < s.playNext + 6) s.fresh.set(i, res);
      try { await cache.put(s.keys[i], res.audio, res.sampleRate); } catch (e) { s.fresh.set(i, res); }
      s.dur.set(i, dur);
      s.avail.add(i);
      flush(s);
    }
  } catch (e) {
    if (current === s) { emit('state', { state: 'error', detail: 'The natural voice failed: ' + e.message }); stop(); }
  } finally {
    s.generating = false;
  }
}

// ---- player ----
function flush(s) {
  if (current !== s) return;
  if (!s.started) {
    const need = s.need || prebufferNeeded(s, MAX_PREBUFFER);
    const have = contiguousSeconds(s);
    if (have < need) {
      const known = need !== Infinity;
      const wait = known && s.rtf ? ` — about ${fmtWait(waitSeconds(s, need - have))}` : '';
      emit('state', { state: 'buffering', detail: `Preparing natural voice${wait}`, progress: known ? have / need : null });
      if (s.rtf != null && s.rtf < SLOW_RTF && !s.hinted) {
        s.hinted = true;
        emit('hint', { text: 'The natural voice is slow on this computer, so it may pause to catch up.', action: 'Use standard voice' });
      }
      return;
    }
    if (!s.avail.has(s.playNext)) return;
    s.started = true;
    s.need = 0;
    s.timelineEnd = 0;
    if (!s.paused) { emit('state', { state: 'playing' }); startTicker(s); }
  }
  fill(s);
}

// Time until enough whole sentences are generated to cover `short` more seconds of audio.
function waitSeconds(s, short) {
  let audio = 0, wall = 0;
  for (let i = s.genNext; i < s.sentences.length && audio < short; i++) {
    if (s.avail.has(i)) continue;
    audio += est(s, i);
    wall += est(s, i) / s.rtf;
  }
  return wall;
}
const fmtWait = (sec) => (sec < 60 ? `${Math.max(1, Math.round(sec))}s` : `${Math.round(sec / 60)} min`);
const aheadSeconds = (s) => s.scheduled.reduce((n, it) => n + Math.max(0, it.end - ctx.currentTime), 0);

async function fill(s) {
  if (s.filling) return;
  s.filling = true;
  try {
    while (current === s && s.started && s.avail.has(s.playNext) && aheadSeconds(s) < MEM_AHEAD) {
      const i = s.playNext;
      const clip = s.fresh.get(i) || (await cache.get(s.keys[i]));
      s.fresh.delete(i);
      if (current !== s) return;
      if (!clip) { s.avail.delete(i); s.genNext = Math.min(s.genNext, i); generate(s); break; } // evicted: regenerate
      s.playNext++;
      schedule(s, i, clip);
    }
  } finally { s.filling = false; }
}

function schedule(s, index, clip) {
  const buffer = ctx.createBuffer(1, clip.audio.length, clip.sampleRate);
  buffer.copyToChannel(clip.audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.05, s.timelineEnd);
  src.start(start);
  const end = start + buffer.duration;
  s.timelineEnd = end + (/[.!?…]["'”’)\]]?$/.test(s.sentences[index]) ? SENTENCE_GAP : 0);
  const entry = { index, src, start, end, duration: buffer.duration, announced: false };
  s.scheduled.push(entry);
  src.onended = () => {
    src.disconnect();
    src.buffer = null; // release the audio as soon as it has played
    const k = s.scheduled.indexOf(entry);
    if (k >= 0) s.scheduled.splice(k, 1);
    if (current !== s) return;
    if (!s.scheduled.length) {
      if (s.playNext >= s.sentences.length) { emit('state', { state: 'ended' }); stop(); return; }
      if (!s.avail.has(s.playNext)) {
        // Ran dry: generation is behind. Rebuffer instead of stuttering.
        s.started = false;
        let rest = 0;
        for (let i = s.playNext; i < s.sentences.length; i++) rest += est(s, i);
        s.need = Math.min(REBUFFER, rest);
        stopTicker(s);
        flush(s);
        return;
      }
    }
    fill(s);
  };
}

// Announce each sentence as it starts, with a word timeline the reader animates locally.
function startTicker(s) {
  stopTicker(s);
  s.ticker = setInterval(() => {
    if (current !== s) return stopTicker(s);
    const t = ctx.currentTime;
    for (const it of s.scheduled) {
      if (!it.announced && t >= it.start) {
        it.announced = true;
        emit('sentence', { index: it.index, duration: it.duration, elapsed: t - it.start, words: wordTimeline(s.sentences[it.index]) });
      }
    }
  }, 50);
}
function stopTicker(s) { clearInterval(s.ticker); s.ticker = null; }

function pause() {
  current.paused = true;
  ctx.suspend();
  stopTicker(current);
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
    s.fresh.clear();
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
  return words.map(([c, l, at]) => [c, l, 0.04 + (at / (total || 1)) * 0.9]);
}

// Read-only snapshot for debugging from the offscreen console (and the test suite).
globalThis.voxlyDebug = () => current && ({ playNext: current.playNext, genNext: current.genNext, avail: current.avail.size,
  scheduled: current.scheduled.length, fresh: current.fresh.size, rtf: current.rtf });
