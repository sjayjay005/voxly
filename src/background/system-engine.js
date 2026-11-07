// Standard voices via chrome.tts. Every sentence is queued up front, so Chrome plays them back-to-back
// with no round trips between sentences. Word boundaries come straight from the voice when it reports them.
export function createSystemEngine(emit) {
  let token = 0;
  let queue = null; // { opts, sentences, endIndex } for the run currently queued

  /** Queue one sentence. `enqueue` is false only for the first, which must interrupt. */
  function speak(i, my, enqueue = true) {
    chrome.tts.speak(queue.sentences[i], {
      ...queue.opts,
      enqueue,
      onEvent(e) {
        if (my !== token) return;
        if (e.type === 'start') emit('sentence', { index: i });
        else if (e.type === 'word') emit('word', { index: i, charIndex: e.charIndex, length: e.length || 0 });
        // endIndex moves when the document grows, so "the end" is wherever it has got to by then.
        else if (e.type === 'end' && i === queue?.endIndex) emit('state', { state: 'ended' });
        else if (e.type === 'error') {
          token++;
          chrome.tts.stop();
          emit('state', { state: 'error', detail: "Your computer's voice couldn't start. Turn on Natural voice, or choose another voice." });
        }
      }
    });
  }

  function start(sentences, from, { systemVoice, rate }) {
    const my = ++token;
    chrome.tts.stop();
    const opts = { rate: Number(rate) || 1 };
    if (systemVoice) opts.voiceName = systemVoice;
    queue = { opts, sentences, endIndex: sentences.length - 1 };
    emit('state', { state: 'playing' });
    for (let i = from; i <= queue.endIndex; i++) speak(i, my, i > from);
  }

  /** The document grew while we were reading it: queue what was added behind what is playing. */
  function extend(sentences) {
    if (!queue || sentences.length <= queue.sentences.length) return;
    const from = queue.sentences.length;
    queue.sentences = sentences;
    queue.endIndex = sentences.length - 1;
    const my = token;
    for (let i = from; i <= queue.endIndex; i++) speak(i, my);
  }

  return {
    start,
    extend,
    pause() { chrome.tts.pause(); emit('state', { state: 'paused' }); },
    resume(restartFrom) {
      chrome.tts.resume();
      emit('state', { state: 'playing' });
      // Some online voices ignore resume(); if nothing is speaking shortly after, restart the current sentence.
      const my = token;
      setTimeout(() => chrome.tts.isSpeaking((speaking) => { if (!speaking && my === token) restartFrom(); }), 350);
    },
    stop() { token++; queue = null; chrome.tts.stop(); }
  };
}
