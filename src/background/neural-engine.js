// Proxy for the natural (Kokoro) voice, which lives in an offscreen document.
// The offscreen document is created on demand and closed when it reports it has been idle,
// so the model's memory is released whenever you're not listening.
//
// Two kinds of event come back. Playback events (state, sentence, hint) go straight to the
// reader. Coordination events (ready, prime) are for whoever is driving the engine — the hybrid
// engine uses them to decide when to hand over from the system voice — and reach it via listen().
const DOC = 'src/offscreen/offscreen.html';
const PRIVATE = new Set(['ready', 'prime']);

export function createNeuralEngine(emit) {
  let sid = 0;
  let creating = null;
  const listeners = new Set();

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
    if (PRIVATE.has(ev)) {
      for (const fn of listeners) fn(ev, data);
      return;
    }
    emit(ev, data);
  });

  /**
   * `prime: true` generates without playing, so the system voice can read aloud meanwhile.
   * `blockStarts` lets the caller hand over at a paragraph break rather than mid-thought.
   */
  async function start(sentences, from, { neuralVoice, rate, handoff }, { prime = false, blockStarts = [] } = {}) {
    sid++;
    if (!prime) emit('state', { state: 'buffering', detail: 'Starting natural voice' });
    await ensureDoc();
    send('start', {
      sentences, from, voice: neuralVoice, speed: Number(rate) || 1,
      prime, blockStarts, handoff: !!handoff
    });
  }

  return {
    start,
    /** Tell the player where the system voice has reached, so it knows when it can take over. */
    at(index) { send('at', { index }); },
    /** Stop priming and start playing from `from`. */
    begin(from) { send('begin', { from }); },
    /** A speed change: keep playing and re-generate in the background, never start over. */
    rate(speed) { send('rate', { speed: Number(speed) || 1 }); },
    /** The document grew: generate into the new sentences rather than stopping at the old end. */
    extend(sentences, blockStarts) { send('extend', { sentences, blockStarts }); },
    pause() { send('pause'); },
    resume() { send('resume'); },
    stop() { send('stop'); sid++; },
    /** Subscribe to coordination events (`ready`, `prime`). Returns an unsubscribe function. */
    listen(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}
