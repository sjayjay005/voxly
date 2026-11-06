// Tests for the natural-voice pacing arithmetic. These are the numbers that decide whether a
// slow machine waits, stalls or hands over, so they are worth pinning down.
//   npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimate, contiguousSeconds, restAvailable, prebufferNeeded, waitSeconds, fmtWait,
  wordTimeline, handoffPoint, pickThreads, idleCloseMs, clauseChunks,
  MAX_PREBUFFER, MAX_WAIT, CHARS_PER_SEC
} from '../src/offscreen/pacing.js';

/** A session view: `generated` maps index -> duration in seconds; everything else is pending. */
const session = (sentences, generated = {}, { speed = 1, rtf = 1, genNext = 0 } = {}) => ({
  sentences,
  dur: new Map(Object.entries(generated).map(([i, d]) => [Number(i), d])),
  avail: new Set(Object.keys(generated).map(Number)),
  speed, rtf, genNext
});

const sentences = (n, len = 100) => Array.from({ length: n }, () => 'x'.repeat(len));

test('estimate uses the real duration once a sentence is generated', () => {
  const s = session(sentences(2), { 0: 7.5 });
  assert.equal(estimate(s, 0), 7.5);
  assert.equal(estimate(s, 1), 100 / CHARS_PER_SEC);
});

test('estimate scales its guess by playback speed', () => {
  const slow = session(sentences(1), {}, { speed: 1 });
  const fast = session(sentences(1), {}, { speed: 2 });
  assert.equal(estimate(fast, 0), estimate(slow, 0) / 2);
});

test('contiguousSeconds stops at the first gap', () => {
  const s = session(sentences(5), { 0: 1, 1: 2, 3: 4 });
  assert.equal(contiguousSeconds(s, 0), 3);     // 0 and 1, then 2 is missing
  assert.equal(contiguousSeconds(s, 3), 4);     // 3 only, 4 is missing
  assert.equal(contiguousSeconds(s, 2), 0);     // starts on a gap
});

test('restAvailable is true only when nothing is left to generate', () => {
  const s = session(sentences(3), { 1: 1, 2: 1 });
  assert.equal(restAvailable(s, 1), true);
  assert.equal(restAvailable(s, 0), false);
});

test('prebufferNeeded waits for a measurement before committing to a number', () => {
  const s = session(sentences(5), {}, { rtf: null });
  assert.equal(prebufferNeeded(s, 0), Infinity);
});

test('prebufferNeeded is zero when the whole rest is already generated', () => {
  const s = session(sentences(3), { 0: 5, 1: 5, 2: 5 });
  assert.equal(prebufferNeeded(s, 0), 0);
});

test('a machine faster than realtime buffers only the next sentence', () => {
  const s = session(sentences(20), {}, { rtf: 2 });
  const need = prebufferNeeded(s, 0);
  const oneSentence = 100 / CHARS_PER_SEC;
  assert.ok(need < oneSentence + 1, `expected a short lead, got ${need}`);
});

test('a slow machine is bounded by what it can generate in MAX_WAIT, not by seamlessness', () => {
  // 20 sentences, ~6.9s each at 1x = ~138s of audio. Staying seamless at rtf 0.5 would want
  // ~71s of buffer, but the patience term (rtf * MAX_WAIT) clamps it to 22.5s of audio --
  // which still costs the listener the full 45s of wall-clock wait. This is exactly the
  // behaviour the system-voice lead-in exists to avoid.
  const s = session(sentences(20), {}, { rtf: 0.5 });
  assert.equal(prebufferNeeded(s, 0), 0.5 * MAX_WAIT);
  assert.ok(prebufferNeeded(s, 0) < MAX_PREBUFFER);
});

test('prebufferNeeded never exceeds the cap it is given', () => {
  const s = session(sentences(50), {}, { rtf: 0.3 });
  assert.ok(prebufferNeeded(s, 0, 12) <= 12);
});

test('prebufferNeeded shrinks as more of the article is already cached', () => {
  const all = sentences(10);
  const cold = session(all, {}, { rtf: 0.6 });
  const warm = session(all, { 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7, 8: 7, 9: 7 }, { rtf: 0.6 });
  assert.ok(prebufferNeeded(warm, 2) < prebufferNeeded(cold, 2));
});

test('prebufferNeeded measures from the index asked about, not the start', () => {
  const s = session(sentences(10), { 0: 7, 1: 7 }, { rtf: 0.6 });
  // Asking about index 2 ignores the two already-generated sentences behind it.
  assert.equal(prebufferNeeded(s, 2), prebufferNeeded(session(sentences(8), {}, { rtf: 0.6 }), 0));
});

test('waitSeconds converts the audio shortfall into wall-clock time', () => {
  const s = session(sentences(10), {}, { rtf: 0.5, genNext: 0 });
  const perSentence = 100 / CHARS_PER_SEC;
  // Needing one sentence of audio at half realtime takes about two sentence-durations of time.
  assert.ok(Math.abs(waitSeconds(s, perSentence) - perSentence * 2) < 0.01);
});

test('waitSeconds skips sentences that are already generated', () => {
  const s = session(sentences(10), { 0: 7, 1: 7 }, { rtf: 1, genNext: 0 });
  assert.ok(waitSeconds(s, 5) > 0);
});

test('fmtWait reads as seconds under a minute and minutes above', () => {
  assert.equal(fmtWait(0.1), '1s');
  assert.equal(fmtWait(42), '42s');
  assert.equal(fmtWait(90), '2 min');
});

test('wordTimeline covers every word in order, inside the clip', () => {
  const text = 'The quick brown fox jumps over the lazy dog.';
  const t = wordTimeline(text);
  assert.equal(t.length, 9);
  for (const [charIndex, length, frac] of t) {
    assert.equal(text.slice(charIndex, charIndex + length).trim().length, length);
    assert.ok(frac >= 0 && frac <= 1, `fraction ${frac} out of range`);
  }
  for (let i = 1; i < t.length; i++) assert.ok(t[i][2] >= t[i - 1][2], 'fractions must not go backwards');
});

test('wordTimeline leaves a longer gap after terminal punctuation', () => {
  const [, , afterStop] = wordTimeline('Yes. No')[1];
  const [, , afterPlain] = wordTimeline('Yes no')[1];
  assert.ok(afterStop > afterPlain, 'a full stop should push the next word later');
});

test('wordTimeline handles a single word and empty text', () => {
  assert.equal(wordTimeline('').length, 0);
  assert.equal(wordTimeline('Hello').length, 1);
});

test('handoffPoint prefers a paragraph start just ahead', () => {
  assert.equal(handoffPoint(5, [0, 7, 20]), 7);
  assert.equal(handoffPoint(5, [0, 20]), 5, 'too far away, hand over where we are');
  assert.equal(handoffPoint(5, [0, 3]), 5, 'behind us, not a candidate');
  assert.equal(handoffPoint(5, []), 5);
});

test('clauseChunks leaves a short sentence alone', () => {
  assert.deepEqual(clauseChunks('Short enough.', 90), ['Short enough.']);
});

test('clauseChunks cuts at clause punctuation and keeps every character', () => {
  const text = 'The model loads once; after that it is cached, so replays are instant: '
    + 'that is the whole trick, and it works well on slow machines too.';
  const parts = clauseChunks(text, 60);
  assert.ok(parts.length > 1, 'should have split');
  for (const p of parts) assert.ok(p.length <= 60 || !p.includes(' '), `piece too long: ${p.length}`);
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
});

test('clauseChunks gives up rather than slicing mid-word', () => {
  const unbroken = 'x'.repeat(300);
  assert.deepEqual(clauseChunks(unbroken, 90), [unbroken]);
});

test('pickThreads explores each candidate once, then keeps the fastest', () => {
  // Four cores is the interesting case: half the cores (2), one short of all of them (3), and 1.
  assert.equal(pickThreads(4, {}), 2, 'first session uses half the cores, as before');
  assert.equal(pickThreads(4, { 2: 0.8 }), 3, 'second session tries a higher count');
  assert.equal(pickThreads(4, { 2: 0.8, 3: 1.2 }), 1, 'third session tries the floor');
  assert.equal(pickThreads(4, { 2: 0.8, 3: 1.2, 1: 0.4 }), 3, 'then settles on the best measured');
});

test('pickThreads never asks for more than four threads', () => {
  // ONNX WASM threading stops paying off past four, and the original code capped it there.
  for (const cores of [8, 12, 16]) assert.ok(pickThreads(cores, {}) <= 4);
});

test('pickThreads copes with single-core and unknown core counts', () => {
  assert.equal(pickThreads(1, {}), 1);
  assert.equal(pickThreads(undefined, {}), 1);
  assert.equal(pickThreads(2, { 1: 0.5 }), 1, 'both candidates collapse to 1 on a dual core');
});

test('idleCloseMs keeps a slow-loading model in memory for longer', () => {
  assert.equal(idleCloseMs(0), 60_000, 'no measurement: the old flat minute');
  assert.equal(idleCloseMs(1_000), 60_000, 'a fast load does not need longer');
  assert.equal(idleCloseMs(20_000), 300_000, 'a 20s load earns five minutes');
  assert.equal(idleCloseMs(600_000), 600_000, 'clamped at ten minutes');
});
