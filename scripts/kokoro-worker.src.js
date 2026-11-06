// Kokoro text-to-speech, off the main thread.
// Tuned for modest machines: the 8-bit CPU model (~90 MB) and half the CPU cores. No WebGPU path —
// on integrated GPUs it is slower and needs ~4x the memory.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const THREADS = self.crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1;
let model = null;

function load(id, baseUrl) {
  if (model) return model;
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
    self.postMessage({ id, type: 'progress', percent: Math.round((loaded / total) * 100) });
  };
  const t0 = performance.now();
  model = KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback })
    .then((m) => { console.log(`[voxly] model ready in ${Math.round(performance.now() - t0)}ms, ${THREADS} thread(s)`); return m; });
  model.catch(() => { model = null; });
  return model;
}

async function handle({ data }) {
  const { id, type } = data;
  try {
    if (type === 'generate') {
      const tts = await load(id, data.baseUrl);
      const t0 = performance.now();
      const out = await tts.generate(data.text, { voice: data.voice || 'af_heart', speed: data.speed || 1 });
      const audio = out.audio;
      const secs = audio.length / out.sampling_rate, ms = performance.now() - t0;
      console.log(`[voxly] ${data.text.length} chars → ${secs.toFixed(1)}s audio in ${Math.round(ms)}ms (${(secs * 1000 / ms).toFixed(2)}× realtime)`);
      self.postMessage({ id, type: 'audio', audio, sampleRate: out.sampling_rate }, [audio.buffer]);
    }
  } catch (e) {
    self.postMessage({ id, type: 'error', message: String(e?.message || e) });
  }
}

// One inference at a time; ONNX sessions don't support concurrent runs.
let chain = Promise.resolve();
self.onmessage = (ev) => { chain = chain.then(() => handle(ev)); };
