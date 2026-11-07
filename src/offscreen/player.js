// Natural-voice player. Two independent loops, like a video player with a download manager:
//
//   generator: synthesizes every sentence of the article in order (in a worker) and saves it to the
//              local audio cache. Sentences already cached are skipped, so replays and resumes are instant.
//              It measures this machine's speed (realtime factor, RTF = audio seconds per wall second).
//   player:    keeps only ~30s of decoded audio in memory, scheduled back-to-back on one AudioContext
//              timeline, and frees each clip as soon as it has played.
//
// Three things make this work on a machine slower than realtime:
//
//   1. Prime mode. The service worker can ask us to generate without playing, while the system
//      voice reads aloud immediately. We report `ready` once there is enough audio to take over
//      from wherever the system voice has got to, and `begin` hands playback to us. Nobody waits.
//   2. Speed changes never throw audio away. Clips already generated at another speed keep
//      playing, resampled, while the generator re-makes them at the new speed and swaps them in.
//   3. The opening sentences are generated clause by clause, so the first sound arrives in
//      seconds rather than tens of seconds.
//
// If generation still falls behind, playback shows "Buffering" rather than stuttering. A while
// after you stop, the offscreen document closes and the model's memory is released.
import { AudioCache } from './audio-cache.js';
import {
  MEM_AHEAD, MAX_PREBUFFER, SLOW_RTF, REBUFFER, SENTENCE_GAP,
  estimate, contiguousSeconds, restAvailable, prebufferNeeded, waitSeconds, fmtWait, wordTimeline,
  handoffPoint, clauseChunks, pickThreads, idleCloseMs
} from './pacing.js';

const FAST_RTF = 1.15;      // at or above this the natural voice starts on its own, no lead-in

const WARM_SENTENCES = 3;   // how many opening sentences to generate clause by clause
const WARM_CHUNK = 90;      // ...and how long each of those pieces may be, in characters

const cache = new AudioCache();
// Ask Chrome to keep this extension's storage (model weights + audio cache) under storage pressure.
navigator.storage?.persist?.().catch(() => {});

// ---- what this machine has told us about itself ----
// Remembered across sessions so a cached article can start immediately, and so the thread count
// settles on whatever is actually fastest here.
const num = (k) => { const v = Number(localStorage.getItem(k)); return v > 0 ? v : null; };
const savedRtf = () => num('voxly.rtf');
const savedLoadMs = () => num('voxly.loadMs');
const cores = navigator.hardwareConcurrency || 2;

function threadStats() {
  try {
    const raw = JSON.parse(localStorage.getItem('voxly.threads') || '{}');
    return raw.cores === cores ? raw.stats || {} : {};   // a different machine: measure again
  } catch { return {}; }
}
function recordThreads(threads, rtf) {
  if (!(rtf > 0)) return;
  try {
    const stats = { ...threadStats(), [threads]: rtf };
    localStorage.setItem('voxly.threads', JSON.stringify({ cores, stats }));
  } catch {}
}
const THREADS = pickThreads(cores, threadStats());

// ---- worker RPC ----
const worker = new Worker('kokoro-worker.js');
const pending = new Map();
let rid = 0;
worker.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    if (current) report('state', { state: 'buffering', detail: data.percent < 100 ? 'Downloading natural voice (one time only)' : 'Loading natural voice', progress: data.percent / 100 });
    return;
  }
  if (data.type === 'loaded') {
    try { localStorage.setItem('voxly.loadMs', String(data.ms)); } catch {}
    return;
  }
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  data.type === 'error' ? p.reject(new Error(data.message)) : p.resolve(data);
};
function rpc(msg) {
  const id = ++rid;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id, baseUrl: chrome.runtime.getURL(''), threads: THREADS });
  });
}
// Exposed so tests can substitute a fake synthesizer; production always uses the worker.
globalThis.voxlySynth = { generate: (text, voice, speed) => rpc({ type: 'generate', text, voice, speed }) };

// ---- messaging ----
let current = null;
const send = (ev, data = {}) => chrome.runtime.sendMessage({ source: 'neural', ev, sid: current?.sid, ...data }).catch(() => {});
// While priming we are a background task: the system voice owns the reader, so nothing we would
// normally say about playback state belongs on screen. Only readiness, download progress and
// failures get through.
const report = (ev, data = {}) => {
  if (!current?.prime) return send(ev, data);
  if (ev === 'state' && data.progress != null) return send('prime', data);
  if (ev === 'state' && data.state === 'error') return send(ev, data);
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'neural') return;
  if (msg.op === 'start') start(msg);
  else if (!current || msg.sid !== current.sid) return;
  else if (msg.op === 'at') current.at = msg.index;        // where the system voice has reached
  else if (msg.op === 'begin') begin(msg.from);
  else if (msg.op === 'rate') setRate(msg.speed);
  else if (msg.op === 'extend') extendSession(msg.sentences, msg.blockStarts);
  else if (msg.op === 'pause') pause();
  else if (msg.op === 'resume') resume();
  else if (msg.op === 'stop') stop();
});

let ctx = null;
let idleTimer = null;

async function start({ sid, sentences, from, voice, speed, prime = false, blockStarts = [], handoff = false }) {
  stop();
  clearTimeout(idleTimer);
  ctx ||= new AudioContext({ latencyHint: 'playback', sampleRate: 24000 }); // Kokoro's native rate
  ctx.resume();
  const s = (current = {
    sid, sentences, voice, from, blockStarts,
    speed: Number(speed) || 1,
    // `have` is what we can play right now: index -> { key, speed, dur } where `speed` is the
    // speed it was generated at. `dur` holds each one's length *as it will sound at the current
    // speed*, which is what all the pacing maths wants.
    have: new Map(), keys: [], dur: new Map(), avail: new Set(), fresh: new Map(),
    genNext: from, playNext: from, scheduled: [], timelineEnd: 0,
    rtf: savedRtf(), started: false, need: 0, paused: false, filling: false, ticker: null,
    prime, at: from, announcedReady: false, generated: 0, handoff
  });
  report('state', { state: 'buffering', detail: 'Preparing natural voice', progress: null });

  await adoptCache(s);
  if (current !== s) return;
  if (s.prime && !needsLeadIn(s)) {
    // This machine can carry the natural voice on its own: decline the lead-in before the
    // system voice has said anything.
    s.announcedReady = true;
    send('ready', { from: s.from, immediate: true });
  } else if (s.prime) {
    // Part of this article may already be cached from a previous listen, which can be enough to
    // take over straight away. Check before generating anything.
    checkReady(s);
  }
  if (!s.prime) flush(s);
  generate(s);
}

/**
 * Is a system-voice lead-in worth it? Only when the wait would be real: a fully cached article
 * starts instantly, and a machine comfortably faster than realtime is only a few seconds from
 * its first sentence — not worth changing voice for. Everything else, including a machine we
 * have never measured, gets the lead-in.
 */
function needsLeadIn(s) {
  if (restAvailable(s, s.from)) return false;
  return s.rtf == null || s.rtf < FAST_RTF;
}

/** Look up everything already cached at the current speed and treat it as playable. */
async function adoptCache(s) {
  try {
    s.keys = await Promise.all(s.sentences.map((t) => AudioCache.key(s.voice, s.speed, t)));
    const known = await cache.lookup(s.keys.slice(s.from));
    for (let i = s.from; i < s.keys.length; i++) {
      const dur = known.get(s.keys[i]);
      if (dur != null) offer(s, i, { key: s.keys[i], speed: s.speed, dur });
    }
  } catch (e) {
    console.warn('[voxly] audio cache unavailable', e);
    if (!s.keys.length) s.keys = s.sentences.map(() => null);
  }
}

/**
 * Record that index `i` is playable. Audio generated at the current speed always wins; audio from
 * another speed is accepted as a bridge so the speed control can respond instantly.
 */
function offer(s, i, entry) {
  const held = s.have.get(i);
  if (held && held.speed === s.speed && entry.speed !== s.speed) return;
  s.have.set(i, entry);
  s.avail.add(i);
  // How long it will sound once resampled to the speed the listener asked for.
  s.dur.set(i, entry.dur * (entry.speed / s.speed));
}

const playRate = (s, entry) => s.speed / entry.speed;
const atTargetSpeed = (s, i) => s.have.get(i)?.speed === s.speed;

// ---- generator: whole article, into the cache ----
async function generate(s) {
  if (s.generating) return;
  s.generating = true;
  try {
    // The cursor is re-read every pass and advanced only if nothing moved it while we were
    // awaiting: a speed change rewinds it to the current position, and a for-loop's increment
    // would step straight back over that sentence.
    while (s.genNext < s.sentences.length) {
      if (current !== s) return;
      const i = s.genNext;
      if (atTargetSpeed(s, i)) { s.genNext = i + 1; continue; }
      // Remember which speed this run is for. If the listener changes speed while it is in
      // flight, the audio coming back is for the old speed and must not be filed under the new
      // speed's key — setRate has already rewound the cursor, so drop it and go round again.
      const speed = s.speed, key = s.keys[i];
      const res = await synthesize(s, i);
      if (current !== s) return;
      if (s.speed !== speed) continue;
      const dur = res.audio.length / res.sampleRate;
      // Keep the raw audio in memory only if it's about to play; everything else lives in the cache.
      if (i < s.playNext + 6) s.fresh.set(i, res);
      try {
        if (key) await cache.put(key, res.audio, res.sampleRate);
      } catch (e) { s.fresh.set(i, res); }
      offer(s, i, { key, speed, dur });
      s.generated++;
      if (s.genNext === i) s.genNext = i + 1;
      if (s.prime) checkReady(s); else flush(s);
    }
  } catch (e) {
    if (current === s) { report('state', { state: 'error', detail: 'The natural voice failed: ' + e.message }); stop(); }
  } finally {
    s.generating = false;
  }
}

/**
 * Synthesize one sentence, measuring this machine as we go. The first few sentences of a slow
 * machine's article are generated clause by clause so playback can start sooner; the pieces are
 * concatenated, so the cache and everything downstream see one sentence.
 */
async function synthesize(s, i) {
  const text = s.sentences[i];
  const warming = s.generated < WARM_SENTENCES && s.rtf != null && s.rtf < 1;
  const pieces = warming ? clauseChunks(text, WARM_CHUNK) : [text];
  const parts = [];
  for (const piece of pieces) {
    const t0 = performance.now();
    const out = await globalThis.voxlySynth.generate(piece, s.voice, s.speed);
    if (current !== s) return out;
    parts.push(out);
    // Measure on every piece, so a slow machine's estimate improves within the first sentence
    // rather than only after it.
    measure(s, out.audio.length / out.sampleRate, performance.now() - t0);
  }
  return parts.length === 1 ? parts[0] : concat(parts);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.audio.length, 0);
  const audio = new Float32Array(total);
  let at = 0;
  for (const p of parts) { audio.set(p.audio, at); at += p.audio.length; }
  return { audio, sampleRate: parts[0].sampleRate };
}

/** Roll this machine's measured realtime factor forward and remember it. */
function measure(s, audioSeconds, elapsedMs) {
  const rtf = audioSeconds / Math.max(elapsedMs / 1000, 0.001);
  s.rtf = s.rtf == null ? rtf : s.rtf * 0.7 + rtf * 0.3;
  try { localStorage.setItem('voxly.rtf', String(s.rtf)); } catch {}
  if (s.generated >= 2) recordThreads(THREADS, s.rtf);
}

// ---- prime mode: generating while the system voice reads ----

/**
 * Can we take over from the system voice yet? Measured from one past wherever it has reached,
 * using exactly the same buffer calculation as a cold start.
 */
function checkReady(s) {
  if (s.announcedReady) return;
  // Hand over at the next paragraph break if one is close, so the voice changes at a natural
  // pause rather than mid-thought.
  const next = Math.min(s.at + 1, s.sentences.length - 1);
  const from = handoffPoint(next, s.blockStarts);
  const need = prebufferNeeded(s, from, MAX_PREBUFFER);
  if (need === Infinity || contiguousSeconds(s, from) < need) return;
  s.announcedReady = true;
  send('ready', { from });
}

/** The service worker has stopped the system voice; start playing from `from`. */
function begin(from) {
  const s = current;
  if (!s) return;
  s.prime = false;
  s.playNext = Math.max(s.from, Math.min(from, s.sentences.length - 1));
  s.started = false;
  s.need = 0;
  s.timelineEnd = 0;
  flush(s);
}

/**
 * The document is still being extracted and just got longer. Append the new sentences, adopt any
 * audio already cached for them, and let the generator run on — the loop re-reads s.genNext, so
 * it simply continues rather than having to be restarted.
 */
async function extendSession(sentences, blockStarts) {
  const s = current;
  if (!s || !sentences || sentences.length <= s.sentences.length) return;
  const from = s.sentences.length;
  const added = sentences.slice(from);
  const keys = await Promise.all(added.map((t) => AudioCache.key(s.voice, s.speed, t)));
  if (current !== s) return;
  s.sentences = sentences;
  if (blockStarts) s.blockStarts = blockStarts;
  s.keys = s.keys.concat(keys);
  try {
    const known = await cache.lookup(keys);
    keys.forEach((k, i) => {
      const dur = known.get(k);
      if (dur != null) offer(s, from + i, { key: k, speed: s.speed, dur });
    });
  } catch {}
  if (current !== s) return;
  generate(s);
  if (s.prime) checkReady(s); else flush(s);
}

// ---- speed changes ----

/**
 * The listener moved the speed control. Keep the audio we already have — played back resampled,
 * which shifts its pitch a little — and re-generate from here at the new speed, swapping each
 * sentence in as it arrives. Nothing is discarded and playback does not stop.
 */
async function setRate(speed) {
  const s = current;
  const next = Number(speed) || 1;
  if (!s || next === s.speed) return;
  s.speed = next;

  // Re-interpret everything we hold at the new speed, and re-rate what is already scheduled.
  for (const [i, entry] of s.have) s.dur.set(i, entry.dur * (entry.speed / s.speed));
  for (const it of s.scheduled) { try { it.src.playbackRate.value = playRate(s, it.entry); } catch {} }

  // Point the generator at the current position so the audible sentences are upgraded first.
  s.genNext = s.playNext;
  const keys = await Promise.all(s.sentences.map((t) => AudioCache.key(s.voice, s.speed, t)));
  if (current !== s) return;
  s.keys = keys;
  try {
    const known = await cache.lookup(keys.slice(s.playNext));
    for (let i = s.playNext; i < keys.length; i++) {
      const dur = known.get(keys[i]);
      if (dur != null) offer(s, i, { key: keys[i], speed: s.speed, dur });
    }
  } catch {}
  if (current !== s) return;
  generate(s);
  flush(s);
}

// ---- player ----
function flush(s) {
  if (current !== s || s.prime) return;
  if (!s.started) {
    const need = s.need || prebufferNeeded(s, s.playNext, MAX_PREBUFFER);
    const have = contiguousSeconds(s, s.playNext);
    if (have < need) {
      const known = need !== Infinity;
      const wait = known && s.rtf ? ` — about ${fmtWait(waitSeconds(s, need - have))}` : '';
      report('state', { state: 'buffering', detail: `Preparing natural voice${wait}`, progress: known ? have / need : null });
      if (s.rtf != null && s.rtf < SLOW_RTF && !s.hinted) {
        s.hinted = true;
        // Two different problems need two different offers. If the lead-in is switched off, the
        // fix is to switch it on. If it is already on and we are still short of audio, this
        // machine simply cannot carry the natural voice.
        send('hint', s.handoff
          ? { text: "The natural voice can't keep up on this computer, so it may pause to catch up.", action: 'Use system voice', actionId: 'natural-off' }
          : { text: 'The natural voice is slow on this computer. Voxly can start in your system voice and change over once it catches up.', action: 'Start that way', actionId: 'handoff' });
      }
      return;
    }
    if (!s.avail.has(s.playNext)) return;
    s.started = true;
    s.need = 0;
    s.timelineEnd = 0;
    if (!s.paused) { report('state', { state: 'playing' }); startTicker(s); }
  }
  fill(s);
}

const aheadSeconds = (s) => s.scheduled.reduce((n, it) => n + Math.max(0, it.end - ctx.currentTime), 0);

async function fill(s) {
  if (s.filling) return;
  s.filling = true;
  try {
    while (current === s && s.started && s.avail.has(s.playNext) && aheadSeconds(s) < MEM_AHEAD) {
      const i = s.playNext;
      const entry = s.have.get(i);
      const clip = s.fresh.get(i) || (entry.key && (await cache.get(entry.key)));
      s.fresh.delete(i);
      if (current !== s) return;
      if (!clip) {
        // Evicted from the cache between lookup and use: forget it and regenerate.
        s.have.delete(i);
        s.avail.delete(i);
        s.dur.delete(i);
        s.genNext = Math.min(s.genNext, i);
        generate(s);
        break;
      }
      s.playNext++;
      schedule(s, i, clip, entry);
    }
  } finally { s.filling = false; }
}

function schedule(s, index, clip, entry) {
  const buffer = ctx.createBuffer(1, clip.audio.length, clip.sampleRate);
  buffer.copyToChannel(clip.audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  // 1 for audio made at the current speed; a resampling bridge for audio made at another.
  const rate = playRate(s, entry);
  src.playbackRate.value = rate;
  src.connect(ctx.destination);
  const start = Math.max(ctx.currentTime + 0.05, s.timelineEnd);
  src.start(start);
  const duration = buffer.duration / rate;
  const end = start + duration;
  s.timelineEnd = end + (/[.!?…]["'”’)\]]?$/.test(s.sentences[index]) ? SENTENCE_GAP : 0);
  const it = { index, src, entry, start, end, duration, announced: false };
  s.scheduled.push(it);
  src.onended = () => {
    src.disconnect();
    src.buffer = null; // release the audio as soon as it has played
    const k = s.scheduled.indexOf(it);
    if (k >= 0) s.scheduled.splice(k, 1);
    if (current !== s) return;
    if (!s.scheduled.length) {
      if (s.playNext >= s.sentences.length) { report('state', { state: 'ended' }); stop(); return; }
      if (!s.avail.has(s.playNext)) {
        // Ran dry: generation is behind. Rebuffer instead of stuttering.
        s.started = false;
        let rest = 0;
        for (let i = s.playNext; i < s.sentences.length; i++) rest += estimate(s, i);
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
        report('sentence', { index: it.index, duration: it.duration, elapsed: t - it.start, words: wordTimeline(s.sentences[it.index]) });
      }
    }
  }, 50);
}
function stopTicker(s) { clearInterval(s.ticker); s.ticker = null; }

function pause() {
  current.paused = true;
  ctx.suspend();
  stopTicker(current);
  report('state', { state: 'paused' });
}

function resume() {
  const s = current;
  s.paused = false;
  ctx.resume();
  if (s.started) { startTicker(s); report('state', { state: 'playing' }); }
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
    s.have.clear();
  }
  clearTimeout(idleTimer);
  // A machine that spent 20s loading the model should not have to do it again a minute later.
  idleTimer = setTimeout(() => {
    if (current) return;
    ctx?.close(); ctx = null;
    chrome.runtime.sendMessage({ source: 'neural', ev: 'idle' }).catch(() => {});
  }, idleCloseMs(savedLoadMs()));
}

// Read-only snapshot for debugging from the offscreen console (and the test suite).
globalThis.voxlyDebug = () => current && ({
  playNext: current.playNext, genNext: current.genNext, avail: current.avail.size,
  scheduled: current.scheduled.length, fresh: current.fresh.size, rtf: current.rtf,
  prime: current.prime, at: current.at, speed: current.speed,
  bridged: [...current.have.values()].filter((e) => e.speed !== current.speed).length,
  threads: THREADS, threadStats: threadStats(), idleCloseMs: idleCloseMs(savedLoadMs())
});
