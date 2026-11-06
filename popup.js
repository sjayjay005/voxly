const DEFAULTS = { rate: 1, pitch: 1, voiceName: '', engine: 'chrome', kokoroVoice: 'af_heart' };
const $ = (id) => document.getElementById(id);

// Kokoro voices: [id, label]. a = American, b = British; f = female, m = male.
const KOKORO_VOICES = [
  ['af_heart', 'Heart — US female (best)'], ['af_bella', 'Bella — US female'], ['af_nicole', 'Nicole — US female (soft)'],
  ['af_sarah', 'Sarah — US female'], ['af_sky', 'Sky — US female'], ['af_nova', 'Nova — US female'],
  ['af_alloy', 'Alloy — US female'], ['af_aoede', 'Aoede — US female'], ['af_jessica', 'Jessica — US female'],
  ['af_kore', 'Kore — US female'], ['af_river', 'River — US female'],
  ['am_michael', 'Michael — US male'], ['am_fenrir', 'Fenrir — US male'], ['am_puck', 'Puck — US male'],
  ['am_adam', 'Adam — US male'], ['am_echo', 'Echo — US male'], ['am_eric', 'Eric — US male'],
  ['am_liam', 'Liam — US male'], ['am_onyx', 'Onyx — US male'], ['am_santa', 'Santa — US male'],
  ['bf_emma', 'Emma — UK female'], ['bf_isabella', 'Isabella — UK female'], ['bf_alice', 'Alice — UK female'],
  ['bf_lily', 'Lily — UK female'], ['bm_george', 'George — UK male'], ['bm_fable', 'Fable — UK male'],
  ['bm_lewis', 'Lewis — UK male'], ['bm_daniel', 'Daniel — UK male']
];

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const local = await chrome.storage.local.get({ kokoroReady: false });

  const voices = await chrome.tts.getVoices();
  voices
    .filter((v) => v.voiceName)
    .sort((a, b) => (a.lang || '').localeCompare(b.lang || '') || a.voiceName.localeCompare(b.voiceName))
    .forEach((v) => {
      const o = document.createElement('option');
      o.value = v.voiceName;
      o.textContent = `${v.voiceName}${v.lang ? ' — ' + v.lang : ''}${v.remote ? ' (online)' : ''}`;
      $('voice').append(o);
    });
  for (const [id, label] of KOKORO_VOICES) {
    const o = document.createElement('option'); o.value = id; o.textContent = label; $('kvoice').append(o);
  }

  $('engine').value = s.engine;
  $('voice').value = s.voiceName;
  $('kvoice').value = s.kokoroVoice;
  $('rate').value = s.rate; $('rateVal').textContent = Number(s.rate).toFixed(1) + '×';
  $('pitch').value = s.pitch; $('pitchVal').textContent = Number(s.pitch).toFixed(1);
  if (local.kokoroReady) markReady();
  applyEngine();

  $('engine').addEventListener('change', () => { applyEngine(); save(); });
  $('voice').addEventListener('change', save);
  $('kvoice').addEventListener('change', save);
  $('rate').addEventListener('input', () => { $('rateVal').textContent = Number($('rate').value).toFixed(1) + '×'; });
  $('pitch').addEventListener('input', () => { $('pitchVal').textContent = Number($('pitch').value).toFixed(1); });
  $('rate').addEventListener('change', save);
  $('pitch').addEventListener('change', save);

  $('readSel').addEventListener('click', () => read('auto'));
  $('readPage').addEventListener('click', () => read('page'));
  $('test').addEventListener('click', testVoice);
  $('kdownload').addEventListener('click', () => {
    $('kdownload').disabled = true;
    $('kstatus').textContent = 'Starting download…';
    chrome.runtime.sendMessage({ type: 'kokoro:preload' });
  });
}

// Progress and readiness come straight from the offscreen engine.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'kokoro:event') return;
  if (msg.event === 'progress') {
    $('kstatus').textContent = msg.percent < 100 ? `Downloading… ${msg.percent}%` : 'Warming up…';
  } else if (msg.event === 'ready') {
    chrome.storage.local.set({ kokoroReady: true });
    markReady(msg.device);
  } else if (msg.event === 'loadError') {
    $('kstatus').textContent = 'Download failed: ' + msg.message;
    $('kdownload').disabled = false;
  }
});

function markReady(device) {
  $('kstatus').textContent = 'Neural voices ready' + (device ? ` (running on ${device === 'webgpu' ? 'GPU' : 'CPU'})` : '') + '.';
  $('kdownload').hidden = true;
}

function applyEngine() {
  const k = $('engine').value === 'kokoro';
  $('kokoroBox').hidden = !k;
  $('voice').hidden = k;
  $('kvoice').hidden = !k;
  $('pitchRow').classList.toggle('off', k); // Kokoro has no pitch control
}

async function save() {
  await chrome.storage.sync.set({
    engine: $('engine').value,
    voiceName: $('voice').value,
    kokoroVoice: $('kvoice').value,
    rate: Number($('rate').value),
    pitch: Number($('pitch').value)
  });
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
}

async function testVoice() {
  if ($('engine').value === 'kokoro') {
    // Run the sample through the normal reader so the neural engine handles it.
    await save();
    const tabId = await activeTabId();
    if (tabId) chrome.runtime.sendMessage({ type: 'readText', tabId, text: 'Hi! This is how I sound when I read to you.' });
    return;
  }
  const opts = { rate: Number($('rate').value), pitch: Number($('pitch').value) };
  if ($('voice').value) opts.voiceName = $('voice').value;
  chrome.tts.speak('Hi! This is how I sound when I read to you.', opts);
}

async function read(mode) {
  const tabId = await activeTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ type: 'read', tabId, mode });
  window.close();
}

init();
