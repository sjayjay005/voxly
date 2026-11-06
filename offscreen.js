// Offscreen document: hosts the Kokoro worker, plays the audio and estimates word timing.
const BASE = chrome.runtime.getURL('');
const worker = new Worker('kokoro-worker.js');
let reqId = 0;
const pending = new Map(); // id -> {resolve, reject}
const cache = new Map();   // key -> Promise<{audio, sampleRate}>

let ctx = null, source = null, ticker = null;
let current = null; // {token, index, words, duration, startedAt, lastWord}

worker.onmessage = ({ data }) => {
  const p = pending.get(data.id);
  if (data.type === 'progress') return send({ event: 'progress', percent: data.percent });
  if (!p) return;
  pending.delete(data.id);
  if (data.type === 'error') p.reject(new Error(data.message));
  else p.resolve(data);
};

function call(msg) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id, baseUrl: BASE });
  });
}

function send(payload) {
  chrome.runtime.sendMessage({ type: 'kokoro:event', ...payload }).catch(() => {});
}

function generate(text, voice, speed) {
  const key = `${voice}|${speed}|${text}`;
  if (!cache.has(key)) {
    const p = call({ type: 'generate', text, voice, speed });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

// Kokoro gives no word timestamps, so spread words across the clip by length, with extra weight for punctuation pauses.
function wordTimeline(text) {
  const words = [];
  let total = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const w = m[0];
    const weight = w.length + 1 + (/[.!?]$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
    words.push({ charIndex: m.index, length: w.length, start: total, weight });
    total += weight;
  }
  for (const w of words) w.start /= total || 1;
  return words;
}

function stopPlayback() {
  clearInterval(ticker); ticker = null;
  if (source) { source.onended = null; try { source.stop(); } catch {} source = null; }
  current = null;
}

async function speak({ token, index, text, nextText, voice, speed }) {
  stopPlayback();
  current = { token, index };
  let res;
  try {
    res = await generate(text, voice, speed);
  } catch (e) {
    if (current?.token === token) send({ event: 'error', token, index, message: 'Neural voice failed: ' + e.message });
    return;
  }
  if (current?.token !== token || current.index !== index) return; // user skipped meanwhile
  if (nextText) generate(nextText, voice, speed).catch(() => {}); // prefetch so the next sentence starts instantly

  ctx = ctx || new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const buf = ctx.createBuffer(1, res.audio.length, res.sampleRate);
  buf.copyToChannel(res.audio, 0);
  source = ctx.createBufferSource();
  source.buffer = buf;
  source.connect(ctx.destination);
  current.words = wordTimeline(text);
  current.duration = buf.duration;
  current.startedAt = ctx.currentTime;
  current.lastWord = -1;
  source.onended = () => {
    if (current?.token !== token) return;
    stopPlayback();
    send({ event: 'end', token, index });
  };
  source.start();
  send({ event: 'start', token, index });

  ticker = setInterval(() => {
    if (!current?.words) return;
    const frac = (ctx.currentTime - current.startedAt) / current.duration; // currentTime freezes while suspended
    let i = current.words.findIndex((w, k) => frac < (current.words[k + 1]?.start ?? 1.01)) ;
    if (i < 0) i = current.words.length - 1;
    if (i !== current.lastWord) {
      current.lastWord = i;
      const w = current.words[i];
      send({ event: 'word', token, index, charIndex: w.charIndex, length: w.length });
    }
  }, 60);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'speak': speak(msg); break;
    case 'pause': ctx?.suspend(); break;
    case 'resume': ctx?.resume(); break;
    case 'stop': stopPlayback(); break;
    case 'preload':
      call({ type: 'load' })
        .then((r) => send({ event: 'ready', device: r.device }))
        .catch((e) => send({ event: 'loadError', message: e.message }));
      break;
  }
  return false;
});
