const DEFAULTS = { rate: 1, pitch: 1, voiceName: '', engine: 'chrome', kokoroVoice: 'af_heart' };
const $ = (id) => document.getElementById(id);
const PAUSE_ICON = 'M6.5 5h4v14h-4zM13.5 5h4v14h-4z';
const PLAY_ICON = 'M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z';

// Kokoro voices: [id, label]. a = American, b = British; f = female, m = male.
const KOKORO_VOICES = [
  ['af_heart', 'Heart — US female ★'], ['af_bella', 'Bella — US female'], ['af_nicole', 'Nicole — US female (soft)'],
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

let engine = 'chrome';

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function paintRange(el) {
  const p = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--p', p + '%');
}

const fmtRate = (r) => (Number.isInteger(+r) ? (+r).toFixed(1) : String(+(+r).toFixed(2))) + '×';

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

  $('voice').value = s.voiceName;
  $('kvoice').value = s.kokoroVoice;
  $('rate').value = s.rate; $('rateVal').textContent = fmtRate(s.rate);
  $('pitch').value = s.pitch; $('pitchVal').textContent = Number(s.pitch).toFixed(1);
  paintRange($('rate')); paintRange($('pitch'));
  if (local.kokoroReady) markReady();
  setEngine(s.engine, false);

  for (const b of document.querySelectorAll('#seg button')) b.addEventListener('click', () => { setEngine(b.dataset.v, true); });
  $('voice').addEventListener('change', save);
  $('kvoice').addEventListener('change', save);
  $('rate').addEventListener('input', () => { $('rateVal').textContent = fmtRate($('rate').value); paintRange($('rate')); });
  $('pitch').addEventListener('input', () => { $('pitchVal').textContent = Number($('pitch').value).toFixed(1); paintRange($('pitch')); });
  $('rate').addEventListener('change', save);
  $('pitch').addEventListener('change', save);

  $('readSel').addEventListener('click', () => read('auto'));
  $('readPage').addEventListener('click', () => read('page'));
  $('test').addEventListener('click', testVoice);
  $('kdownload').addEventListener('click', () => {
    $('kdownload').disabled = true;
    $('kstatus').textContent = 'Starting download…';
    $('kbar').style.display = 'block'; $('kbar').classList.add('indet');
    chrome.runtime.sendMessage({ type: 'kokoro:preload' });
  });
  $('nowToggle').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'control', action: 'toggle' }); setTimeout(refreshNow, 120); });
  $('nowStop').addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'control', action: 'stop' }); setTimeout(refreshNow, 120); });
  refreshNow();
}

async function refreshNow() {
  const st = await chrome.runtime.sendMessage({ type: 'getState' }).catch(() => null);
  const on = !!st?.playing;
  $('now').classList.toggle('on', on);
  if (!on) return;
  $('now').classList.toggle('paused', st.paused);
  $('nowText').textContent = `${st.paused ? 'Paused' : 'Reading'} · ${st.index + 1} of ${st.total}`;
  $('nowIcon').setAttribute('d', st.paused ? PLAY_ICON : PAUSE_ICON);
}

// Progress and readiness come straight from the offscreen engine.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'kokoro:event') return;
  if (msg.event === 'progress') {
    $('kbar').style.display = 'block';
    $('kbar').classList.remove('indet');
    $('kbar').firstElementChild.style.width = msg.percent + '%';
    $('kstatus').textContent = msg.percent < 100 ? `Downloading… ${msg.percent}%` : 'Warming up…';
  } else if (msg.event === 'status') {
    $('kstatus').textContent = msg.text;
  } else if (msg.event === 'ready') {
    chrome.storage.local.set({ kokoroReady: true });
    markReady(msg.device);
  } else if (msg.event === 'loadError') {
    $('kstatus').textContent = 'Download failed: ' + msg.message;
    $('kbar').style.display = 'none';
    $('kdownload').disabled = false;
  } else if (msg.event === 'chunk' || msg.event === 'done') {
    $('test').classList.remove('speaking');
  }
});

function markReady(device) {
  $('kstatus').innerHTML = '';
  $('kstatus').append(Object.assign(document.createElement('span'), { className: 'ok', textContent: '✓ Neural voices ready' }),
    device ? ` · running on ${device === 'webgpu' ? 'GPU' : 'CPU'}` : '');
  $('kbar').style.display = 'none';
  $('kdownload').hidden = true;
}

function setEngine(v, persist) {
  engine = v;
  $('seg').dataset.v = v;
  for (const b of document.querySelectorAll('#seg button')) b.classList.toggle('on', b.dataset.v === v);
  const k = v === 'kokoro';
  $('kokoroBox').hidden = !k;
  $('voice').hidden = k;
  $('kvoice').hidden = !k;
  $('pitchRow').classList.toggle('dim', k); // Kokoro has no pitch control
  if (persist) save();
}

async function save() {
  await chrome.storage.sync.set({
    engine,
    voiceName: $('voice').value,
    kokoroVoice: $('kvoice').value,
    rate: Number($('rate').value),
    pitch: Number($('pitch').value)
  });
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
}

async function testVoice() {
  const sample = 'Hi! This is how I sound when I read to you.';
  $('test').classList.add('speaking');
  if (engine === 'kokoro') {
    await save();
    const tabId = await activeTabId();
    if (tabId) chrome.runtime.sendMessage({ type: 'readText', tabId, text: sample });
    return;
  }
  const opts = { rate: Number($('rate').value), pitch: Number($('pitch').value),
                 onEvent: (e) => { if (['end', 'interrupted', 'error', 'cancelled'].includes(e.type)) $('test').classList.remove('speaking'); } };
  if ($('voice').value) opts.voiceName = $('voice').value;
  chrome.tts.speak(sample, opts);
}

async function read(mode) {
  const tabId = await activeTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ type: 'read', tabId, mode });
  window.close();
}

init();
