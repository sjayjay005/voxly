// Standard voices via chrome.tts. Every sentence is queued up front, so Chrome plays them back-to-back
// with no round trips between sentences. Word boundaries come straight from the voice when it reports them.
export function createSystemEngine(emit) {
  let token = 0;

  function start(sentences, from, { systemVoice, rate }) {
    const my = ++token;
    chrome.tts.stop();
    const opts = { rate: Number(rate) || 1 };
    if (systemVoice) opts.voiceName = systemVoice;
    const last = sentences.length - 1;
    emit('state', { state: 'playing' });
    for (let i = from; i <= last; i++) {
      chrome.tts.speak(sentences[i], {
        ...opts,
        enqueue: i > from,
        onEvent(e) {
          if (my !== token) return;
          if (e.type === 'start') emit('sentence', { index: i });
          else if (e.type === 'word') emit('word', { index: i, charIndex: e.charIndex, length: e.length || 0 });
          else if (e.type === 'end' && i === last) emit('state', { state: 'ended' });
          else if (e.type === 'error') { token++; chrome.tts.stop(); emit('state', { state: 'error', detail: "Your computer's voice couldn't start. Turn on Natural voice, or choose another voice." }); }
        }
      });
    }
  }

  return {
    start,
    pause() { chrome.tts.pause(); emit('state', { state: 'paused' }); },
    resume(restartFrom) {
      chrome.tts.resume();
      emit('state', { state: 'playing' });
      // Some online voices ignore resume(); if nothing is speaking shortly after, restart the current sentence.
      const my = token;
      setTimeout(() => chrome.tts.isSpeaking((speaking) => { if (!speaking && my === token) restartFrom(); }), 350);
    },
    stop() { token++; chrome.tts.stop(); }
  };
}
