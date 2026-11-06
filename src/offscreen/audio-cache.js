// Local cache of generated natural-voice audio (IndexedDB, this extension only — nothing leaves the machine).
// Clips are stored as 16-bit PCM (half the size of float), keyed by voice + speed + a hash of the sentence.
// When the cache passes its cap, the least recently played clips are removed first.
export class AudioCache {
  constructor(name = 'voxly-audio', capBytes = 200 * 1024 * 1024) {
    this.cap = capBytes;
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('pcm');
        db.createObjectStore('meta', { keyPath: 'key' }).createIndex('at', 'at');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.writes = 0;
  }

  static async key(voice, speed, text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${voice}|${speed}|${hex}`;
  }

  /** @returns {Promise<Map<string, number>>} key → duration (seconds) for the keys that are cached */
  async lookup(keys) {
    const db = await this.db;
    const store = db.transaction('meta').objectStore('meta');
    const found = new Map();
    await Promise.all(keys.map((k) => new Promise((res) => {
      const r = store.get(k);
      r.onsuccess = () => { if (r.result) found.set(k, r.result.dur); res(); };
      r.onerror = () => res();
    })));
    return found;
  }

  async get(key) {
    const db = await this.db;
    const tx = db.transaction(['pcm', 'meta'], 'readwrite');
    const [buf, meta] = await Promise.all([req(tx.objectStore('pcm').get(key)), req(tx.objectStore('meta').get(key))]);
    if (!buf || !meta) return null;
    meta.at = Date.now();
    tx.objectStore('meta').put(meta);
    const i16 = new Int16Array(buf);
    const audio = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) audio[i] = i16[i] / 32767;
    return { audio, sampleRate: meta.sr };
  }

  async put(key, audio, sampleRate) {
    const i16 = new Int16Array(audio.length);
    for (let i = 0; i < audio.length; i++) i16[i] = Math.max(-1, Math.min(1, audio[i])) * 32767;
    const db = await this.db;
    const tx = db.transaction(['pcm', 'meta'], 'readwrite');
    tx.objectStore('pcm').put(i16.buffer, key);
    tx.objectStore('meta').put({ key, dur: audio.length / sampleRate, sr: sampleRate, bytes: i16.byteLength, at: Date.now() });
    await done(tx);
    if (++this.writes % 20 === 0) this.evict().catch(() => {});
  }

  async evict() {
    const db = await this.db;
    const all = await req(db.transaction('meta').objectStore('meta').getAll());
    let total = all.reduce((n, m) => n + m.bytes, 0);
    if (total <= this.cap) return;
    const tx = db.transaction(['pcm', 'meta'], 'readwrite');
    for (const m of all.sort((a, b) => a.at - b.at)) {
      if (total <= this.cap * 0.85) break;
      tx.objectStore('pcm').delete(m.key);
      tx.objectStore('meta').delete(m.key);
      total -= m.bytes;
    }
    await done(tx);
  }
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
