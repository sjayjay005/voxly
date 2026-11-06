// Proxy for the natural (Kokoro) voice, which lives in an offscreen document.
// The offscreen document is created on demand and closed when it reports it has been idle,
// so the model's memory is released whenever you're not listening.
const DOC = 'src/offscreen/offscreen.html';

export function createNeuralEngine(emit) {
  let sid = 0;
  let creating = null;

  async function ensureDoc() {
    const docs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (docs.length) return;
    creating ||= chrome.offscreen.createDocument({
      url: DOC,
      // WORKERS only: AUDIO_PLAYBACK would auto-close the document after 30s of silence, mid-buffering.
      reasons: ['WORKERS'],
      justification: 'Runs the on-device neural text-to-speech model in a worker and plays its audio.'
    }).finally(() => { creating = null; });
    await creating;
  }

  const send = (op, data = {}) => chrome.runtime.sendMessage({ target: 'neural', op, sid, ...data }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.source !== 'neural') return;
    if (msg.ev === 'idle') {
      chrome.offscreen.closeDocument().catch(() => {});
      return;
    }
    if (msg.sid !== sid) return; // events from a session we've already replaced
    const { source, ev, sid: _s, ...data } = msg;
    emit(ev, data);
  });

  return {
    async start(sentences, from, { neuralVoice, rate }) {
      sid++;
      emit('state', { state: 'buffering', detail: 'Starting natural voice' });
      await ensureDoc();
      send('start', { sentences, from, voice: neuralVoice, speed: Number(rate) || 1 });
    },
    pause() { send('pause'); },
    resume() { send('resume'); },
    stop() { send('stop'); sid++; }
  };
}
