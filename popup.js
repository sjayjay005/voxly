const DEFAULTS = { rate: 1, pitch: 1, voiceName: '' };
const $ = (id) => document.getElementById(id);

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function init() {
  const s = await chrome.storage.sync.get(DEFAULTS);

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
  $('voice').value = s.voiceName;
  $('rate').value = s.rate; $('rateVal').textContent = Number(s.rate).toFixed(1) + '×';
  $('pitch').value = s.pitch; $('pitchVal').textContent = Number(s.pitch).toFixed(1);

  $('voice').addEventListener('change', save);
  $('rate').addEventListener('input', () => { $('rateVal').textContent = Number($('rate').value).toFixed(1) + '×'; });
  $('pitch').addEventListener('input', () => { $('pitchVal').textContent = Number($('pitch').value).toFixed(1); });
  $('rate').addEventListener('change', save);
  $('pitch').addEventListener('change', save);

  $('readSel').addEventListener('click', () => read('auto'));
  $('readPage').addEventListener('click', () => read('page'));
  $('test').addEventListener('click', () => {
    const opts = { rate: Number($('rate').value), pitch: Number($('pitch').value) };
    if ($('voice').value) opts.voiceName = $('voice').value;
    chrome.tts.speak('Hi! This is how I sound when I read to you.', opts);
  });
}

async function save() {
  await chrome.storage.sync.set({
    voiceName: $('voice').value,
    rate: Number($('rate').value),
    pitch: Number($('pitch').value)
  });
  chrome.runtime.sendMessage({ type: 'settingsChanged' });
}

async function read(mode) {
  const tabId = await activeTabId();
  if (!tabId) return;
  chrome.runtime.sendMessage({ type: 'read', tabId, mode });
  window.close();
}

init();
