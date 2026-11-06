// Offscreen document: hosts the Kokoro worker and owns neural playback.
// It generates a few sentences ahead and schedules them back-to-back on one AudioContext timeline,
// so there are no gaps or round trips between sentences.
const BASE = chrome.runtime.getURL('');
const worker = new Worker('kokoro-worker.js');
const LOOKAHEAD = 3;          // sentences generated ahead of what's playing
const SENTENCE_PAUSE = 0.07;  // seconds of breath after a full stop

let reqId = 0;
const pending = new Map();
const cache = new Map(); // `${voice}|${speed}|${text}` -> Promise<{audio, sampleRate}>
let ctx = null;
let session = null;

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') return send({ event: 'progress', percent: data.percent });
  if (data.type === 'status') return send({ event: 'status', text: data.text });
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  if (data.type === 'error') p.reject(new Error(data.message)); else p.resolve(data);
};

function call(msg) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id, baseUrl: BASE });
  });
}

const send = (payload) => chrome.runtime.sendMessage({ type: 'kokoro:event', ...payload }).catch(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function generate(text, voice, speed) {
  const key = `${voice}|${speed}|${text}`;
  if (!cache.has(key)) {
    const p = call({ type: 'generate', text, voice, speed });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    while (cache.size > 16) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// Kokoro returns no word timestamps, so spread words across the clip by length, weighting punctuation pauses.
function wordTimeline(text) {
  const words = [];
  let total = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0];
    const weight = w.length + 1.5 + (/[.!?]["')\]]?$/.test(w) ? 5 : /[,;:]$/.test(w) ? 3 : 0);
    words.push({ charIndex: m.index, length: w.length, at: total });
    total += weight;
  }
  // Kokoro pads a little silence at both ends; squeeze words into the middle ~92% of the clip.
  for (const w of words) w.at = 0.03 + (w.at / (total || 1)) * 0.92;
  return words;
}

function stopAll() {
  if (!session) return;
  clearInterval(session.ticker);
  for (const src of session.sources) { src.onended = null; try { src.stop(); } catch {} }
  session = null;
}

async function play({ token, chunks, startIndex, voice, speed }) {
  stopAll();
  ctx = ctx || new AudioContext({ latencyHint: 'playback' });
  if (ctx.state === 'suspended') await ctx.resume();
  const s = (session = { token, chunks, sources: [], items: [], nextTime: 0, lastChunk: -1, lastWord: -1 });
  s.ticker = setInterval(() => tick(s), 40);

  for (let i = startIndex; i < chunks.length; i++) {
    // Stay a few sentences ahead of the playhead, no further (saves CPU and makes speed changes cheap).
    while (session === s && s.items.filter((it) => it.end > ctx.currentTime).length >= LOOKAHEAD) await sleep(120);
    if (session !== s) return;

    const isFirst = i === startIndex;
    if (isFirst && !cache.has(`${voice}|${speed}|${chunks[i]}`)) send({ event: 'status', text: 'Generating speech…' });
    const slow = isFirst && setTimeout(() => session === s && !s.items.length &&
      send({ event: 'status', text: 'Still generating — this computer runs the neural voice slowly. Standard voices start instantly.' }), 20000);

    let res;
    try {
      res = await generate(chunks[i], voice, speed);
    } catch (e) {
      clearTimeout(slow);
      if (session === s) send({ event: 'error', token, message: 'Neural voice failed: ' + e.message });
      return;
    }
    clearTimeout(slow);
    if (session !== s) return;
    schedule(s, i, res);
  }
  s.allScheduled = true;
}

function schedule(s, i, res) {
  const buf = ctx.createBuffer(1, res.audio.length, res.sampleRate);
  buf.copyToChannel(res.audio, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  // If generation fell behind, start as soon as possible; otherwise butt it right up against the previous clip.
  const when = Math.max(ctx.currentTime + 0.03, s.nextTime);
  src.start(when);
  const endsSentence = /[.!?…]["')\]]?$/.test(s.chunks[i]);
  s.nextTime = when + buf.duration + (endsSentence ? SENTENCE_PAUSE : 0);
  s.items.push({ index: i, start: when, end: when + buf.duration, words: wordTimeline(s.chunks[i]) });
  s.sources.push(src);
  src.onended = () => {
    if (session === s && s.allScheduled && i === s.chunks.length - 1) { send({ event: 'done', token: s.token }); stopAll(); }
  };
}

function tick(s) {
  if (session !== s || !ctx) return;
  const t = ctx.currentTime; // freezes while suspended, so pause/resume keeps highlighting in sync
  const item = s.items.find((it) => t >= it.start && t < it.end);
  if (!item) return;
  if (item.index !== s.lastChunk) {
    s.lastChunk = item.index; s.lastWord = -1;
    send({ event: 'chunk', token: s.token, index: item.index });
  }
  const frac = (t - item.start) / (item.end - item.start);
  let w = 0;
  while (w + 1 < item.words.length && item.words[w + 1].at <= frac) w++;
  if (w !== s.lastWord) {
    s.lastWord = w;
    const word = item.words[w];
    if (word) send({ event: 'word', token: s.token, index: item.index, charIndex: word.charIndex, length: word.length });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'play': play(msg); break;
    case 'pause': ctx?.suspend(); break;
    case 'resume': ctx?.resume(); break;
    case 'stop': stopAll(); break;
    case 'preload':
      call({ type: 'load' })
        .then((r) => send({ event: 'ready', device: r.device }))
        .catch((e) => send({ event: 'loadError', message: e.message }));
      break;
  }
  return false;
});
