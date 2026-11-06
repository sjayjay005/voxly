// The arithmetic behind natural-voice playback, kept separate from the player so it can be
// tested without an AudioContext, a worker or IndexedDB.
//
// Every function here takes a plain view of the session:
//   { sentences: string[], dur: Map<index, seconds>, avail: Set<index>, speed, rtf, genNext }
// and a `from` index to reason about — the position playback would start or continue from.
// Nothing here touches the DOM or mutates its argument.

export const MEM_AHEAD = 30;          // seconds of audio decoded/scheduled ahead of the playhead
export const MAX_PREBUFFER = 60;      // longest initial buffer, in seconds of audio
export const MAX_WAIT = 45;           // ...and never ask you to wait more than ~45s of wall-clock time for it
export const SLOW_RTF = 0.5;          // below this, lead in with the system voice instead of waiting
export const REBUFFER = 10;           // after running dry, wait for this much audio before continuing
export const CHARS_PER_SEC = 14.5;    // rough Kokoro speaking rate at 1×, for estimates only
export const SENTENCE_GAP = 0.06;

/** Known duration if the sentence has been generated, otherwise a guess from its length. */
export const estimate = (s, i) => s.dur.get(i) ?? s.sentences[i].length / (CHARS_PER_SEC * s.speed);

/** Seconds of unbroken generated audio starting at `from`. */
export function contiguousSeconds(s, from) {
  let t = 0;
  for (let i = from; i < s.sentences.length && s.avail.has(i); i++) t += s.dur.get(i);
  return t;
}

/** True when everything from `from` to the end has already been generated. */
export function restAvailable(s, from) {
  for (let i = from; i < s.sentences.length; i++) if (!s.avail.has(i)) return false;
  return true;
}

/**
 * How much audio to buffer before playing from `from`, so that playback never overtakes
 * generation. Infinity means "we don't know this machine's speed yet, measure first".
 */
export function prebufferNeeded(s, from, cap = MAX_PREBUFFER) {
  if (restAvailable(s, from)) return 0;
  if (s.rtf == null) return Infinity;
  let missing = 0, nextMissing = 0;
  for (let i = from; i < s.sentences.length; i++) {
    if (s.avail.has(i)) continue;
    if (!nextMissing) nextMissing = estimate(s, i);
    missing += estimate(s, i);
  }
  const lead = nextMissing / s.rtf + 0.5;                         // cover making the next sentence
  if (s.rtf >= 1.15) return Math.min(cap, lead);                  // faster than realtime: just the lead
  const seamless = missing * (1 - s.rtf) + 2;                     // enough to never run dry
  const patience = Math.max(s.rtf * MAX_WAIT, estimate(s, from)); // what we can make in ~MAX_WAIT
  return Math.min(cap, Math.max(seamless, lead), Math.max(patience, lead));
}

/** Wall-clock seconds until `short` more seconds of whole sentences have been generated. */
export function waitSeconds(s, short) {
  let audio = 0, wall = 0;
  for (let i = s.genNext; i < s.sentences.length && audio < short; i++) {
    if (s.avail.has(i)) continue;
    audio += estimate(s, i);
    wall += estimate(s, i) / s.rtf;
  }
  return wall;
}

export const fmtWait = (sec) => (sec < 60 ? `${Math.max(1, Math.round(sec))}s` : `${Math.round(sec / 60)} min`);

/**
 * Kokoro reports no word timestamps, so spread the words across the clip by length, giving
 * punctuation the pause it would really take. Returns [charIndex, length, fractionOfClip].
 */
export function wordTimeline(text) {
  const words = [];
  let total = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0];
    words.push([m.index, w.length, total]);
    total += w.length + 1.5 + (/[.!?]["'”’)\]]?$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0);
  }
  return words.map(([c, l, at]) => [c, l, 0.04 + (at / (total || 1)) * 0.9]);
}

/**
 * Where to hand over from the system voice to the natural one. Prefers the start of the next
 * paragraph within `window` sentences, so the voice changes at a natural break rather than
 * mid-thought. Falls back to `from`.
 */
export function handoffPoint(from, blockStarts = [], window = 3) {
  for (const b of blockStarts) if (b >= from && b <= from + window) return b;
  return from;
}

/**
 * Pick the thread count to load the model with. Candidates are tried one per session and the
 * measured realtime factor remembered, so a machine settles on its best setting without ever
 * loading the model twice in one sitting.
 * `stats` maps thread count -> measured rtf. Returns the count to use next.
 */
export function pickThreads(cores, stats = {}) {
  const n = Math.max(1, cores || 2);
  // Four is the ceiling the original code chose: ONNX WASM threading stops paying off past it.
  const clamp = (x) => Math.min(4, Math.max(1, x));
  const candidates = [...new Set([clamp(Math.floor(n / 2)), clamp(n - 1), 1])];
  const untried = candidates.find((c) => !(c in stats));
  if (untried !== undefined) return untried;
  return candidates.reduce((best, c) => (stats[c] > stats[best] ? c : best), candidates[0]);
}

/**
 * How long to keep the model in memory after playback stops. A machine that spends 20s loading
 * it should not throw that away after a minute of silence.
 */
export function idleCloseMs(loadMs) {
  const base = 60_000;
  if (!loadMs || !Number.isFinite(loadMs)) return base;
  return Math.min(10 * 60_000, Math.max(base, loadMs * 15));
}
