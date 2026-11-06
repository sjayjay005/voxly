// Kokoro text-to-speech, off the main thread.
//
// Two engines, chosen by measurement rather than guesswork:
//   cpu  8-bit model (~90 MB) on WebAssembly, every core but one. Small and works everywhere.
//   gpu  fp32 model (~330 MB) on WebGPU. Several times faster on a real GPU (Apple Silicon, discrete cards,
//        recent integrated graphics), slower than the CPU on old or software adapters, ~4x the memory.
//
// Policy: "the lightest engine that keeps up with playback".
//   - A new machine starts on the CPU engine (small download, always works) and measures its realtime factor.
//   - If an engine can't keep up with realtime and the other one has never been measured here, the other one is
//     loaded and measured on the next few sentences. The faster one stays, the loser is freed.
//   - The verdict (both measurements + GPU adapter name) is sent to the player, which stores it, so later
//     sessions start on the right engine straight away. A different GPU adapter invalidates the GPU measurement.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
// All cores but one so the page and the audio thread stay smooth; ORT gains little past 6 threads on this model.
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 2) - 1)) : 1;
const TARGET_RTF = 1.15;     // "keeps up": audio seconds per wall second, with a little headroom
const SAMPLES_TO_JUDGE = 2;  // sentences measured before an engine's speed is trusted (the first is a warm-up)
const WIN_MARGIN = 1.25;     // the challenger must be this much faster to replace the engine that was running

const ENGINES = {
  cpu: { dtype: 'q8', device: 'wasm' },
  gpu: { dtype: 'fp32', device: 'webgpu' }
};
const state = {
  cpu: { model: null, rtf: null, samples: 0, failed: false },
  gpu: { model: null, rtf: null, samples: 0, failed: false }
};
let active = null;       // 'cpu' | 'gpu'
let trial = null;        // { challenger, incumbent } while the other engine is being measured
let adapter = undefined; // GPU adapter description, '' when WebGPU is unusable; undefined until probed
let configured = false;

async function probeAdapter() {
  if (adapter !== undefined) return adapter;
  adapter = '';
  try {
    const a = navigator.gpu && await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (a && !a.isFallbackAdapter) {
      const info = a.info || (a.requestAdapterInfo && await a.requestAdapterInfo()) || {};
      const desc = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ').toLowerCase();
      // Software rasterizers are never worth the 330 MB model.
      if (!/swiftshader|llvmpipe|software/.test(desc)) adapter = desc || 'unknown gpu';
    }
  } catch { /* no WebGPU */ }
  return adapter;
}

// Apply what the player remembered from earlier sessions (see player.js).
async function configure(pref) {
  if (configured) return;
  configured = true;
  await probeAdapter();
  if (!pref) return;
  for (const e of ['cpu', 'gpu']) {
    const rtf = pref.rtf?.[e];
    if (rtf == null) continue;
    if (e === 'gpu' && pref.adapter !== adapter) continue; // different GPU or driver: measure again
    state[e].rtf = rtf;
    state[e].samples = SAMPLES_TO_JUDGE;
  }
  if (pref.engine === 'gpu' && adapter && state.gpu.rtf != null) active = 'gpu';
}

function load(engine, id, baseUrl) {
  const s = state[engine];
  if (s.model) return s.model;
  // The WASM runtime ships inside the extension (Chrome Web Store forbids loading code from a CDN).
  env.backends.onnx.wasm.wasmPaths = baseUrl + 'ort/';
  env.backends.onnx.wasm.numThreads = THREADS;
  env.allowLocalModels = false;
  env.useBrowserCache = true; // weights are downloaded once, then served from the browser cache

  const files = new Map();
  const progress_callback = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    files.set(p.file, [p.loaded, p.total]);
    let loaded = 0, total = 0;
    for (const [l, t] of files.values()) { loaded += l; total += t; }
    self.postMessage({ id, type: 'progress', engine, percent: Math.round((loaded / total) * 100) });
  };
  const t0 = performance.now();
  s.model = KokoroTTS.from_pretrained(MODEL_ID, { ...ENGINES[engine], progress_callback })
    .then((m) => {
      console.log(`[voxly] ${engine} engine ready in ${Math.round(performance.now() - t0)}ms` + (engine === 'cpu' ? `, ${THREADS} thread(s)` : ` (${adapter})`));
      return m;
    });
  s.model.catch((e) => { s.model = null; s.failed = true; console.warn(`[voxly] ${engine} engine failed to load:`, e); });
  return s.model;
}

async function unload(engine) {
  const s = state[engine];
  const m = s.model;
  s.model = null;
  try { await (await m)?.model?.dispose?.(); } catch { /* already gone */ }
}

const usable = (e) => !state[e].failed && (e === 'cpu' || !!adapter);

// Picks the engine for the next sentence and starts/ends trials of the other one.
function chooseEngine() {
  if (!active) {
    active = 'cpu';
    // The CPU was measured too slow in an earlier session but this GPU never was: try it first, as a challenger,
    // so a slow GPU still loses to the CPU instead of being kept blindly.
    if (state.cpu.rtf != null && state.cpu.rtf < TARGET_RTF && usable('gpu') && state.gpu.rtf == null) {
      trial = { challenger: 'gpu', incumbent: 'cpu' };
      active = 'gpu';
    }
  }
  if (trial) {
    const c = state[trial.challenger], i = state[trial.incumbent];
    if (c.failed) { active = trial.incumbent; trial = null; return active; }
    if (c.samples < SAMPLES_TO_JUDGE) return active;
    const winner = c.rtf > i.rtf * WIN_MARGIN ? trial.challenger : trial.incumbent;
    const loser = winner === trial.challenger ? trial.incumbent : trial.challenger;
    console.log(`[voxly] ${winner} engine wins (${c.rtf.toFixed(2)}× vs ${i.rtf.toFixed(2)}× realtime); freeing ${loser}`);
    unload(loser);
    active = winner;
    trial = null;
    announce();
    return active;
  }
  const a = state[active];
  if (a.samples >= SAMPLES_TO_JUDGE && a.rtf < TARGET_RTF) {
    const other = active === 'cpu' ? 'gpu' : 'cpu';
    if (usable(other) && state[other].rtf == null) {
      console.log(`[voxly] ${active} engine is ${a.rtf.toFixed(2)}× realtime; trying the ${other} engine`);
      trial = { challenger: other, incumbent: active };
      active = other;
    }
  }
  return active;
}

function announce() {
  // An engine that failed to load is reported as unmeasured, so a later session tries it again (the failure may
  // have been transient) instead of being locked out of it for good.
  const rtf = (e) => (state[e].failed ? null : state[e].rtf);
  self.postMessage({ type: 'engine', engine: active, adapter, rtf: { cpu: rtf('cpu'), gpu: rtf('gpu') } });
}

function record(engine, rtf) {
  const s = state[engine];
  s.samples++;
  // The first sentence on an engine includes warm-up (shader compilation, lazy kernels): don't let it drag the
  // estimate down; replace it entirely with the second sample, then smooth.
  s.rtf = s.samples <= 2 || s.rtf == null ? rtf : s.rtf * 0.6 + rtf * 0.4;
}

async function generate(data) {
  const { id } = data;
  await configure(data.pref);
  let engine = chooseEngine();
  let tts;
  try {
    tts = await load(engine, id, data.baseUrl);
  } catch (e) {
    // The challenger (or a remembered GPU engine) couldn't load: fall back to the other one.
    if (trial) { active = trial.incumbent; trial = null; }
    else if (engine === 'gpu') active = 'cpu';
    else throw e;
    engine = active;
    announce();
    tts = await load(engine, id, data.baseUrl);
  }
  const t0 = performance.now();
  const out = await tts.generate(data.text, { voice: data.voice || 'af_heart', speed: data.speed || 1 });
  const audio = out.audio;
  const secs = audio.length / out.sampling_rate, ms = performance.now() - t0;
  const rtf = secs * 1000 / Math.max(ms, 1);
  record(engine, rtf);
  if (state[engine].samples === SAMPLES_TO_JUDGE && !trial) announce();
  console.log(`[voxly] ${engine}: ${data.text.length} chars → ${secs.toFixed(1)}s audio in ${Math.round(ms)}ms (${rtf.toFixed(2)}× realtime)`);
  self.postMessage({ id, type: 'audio', audio, sampleRate: out.sampling_rate, engine, genMs: ms, rtf: state[engine].rtf }, [audio.buffer]);
}

async function handle({ data }) {
  const { id, type } = data;
  try {
    if (type === 'generate') await generate(data);
  } catch (e) {
    self.postMessage({ id, type: 'error', message: String(e?.message || e) });
  }
}

// One inference at a time; ONNX sessions don't support concurrent runs.
let chain = Promise.resolve();
self.onmessage = (ev) => { chain = chain.then(() => handle(ev)); };
