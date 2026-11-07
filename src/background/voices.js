// Kokoro voice ids are <accent><gender>_<name>: a = American, b = British; f = female, m = male.
// Ordered by the quality grades published on the model card, best first, because the only way to
// judge a voice from a dropdown is to be told — and 28 unordered names tells you nothing.
export const NEURAL_VOICES = [
  // American, graded A to C
  ['af_heart', 'Heart (US)'], ['af_bella', 'Bella (US)'], ['af_nicole', 'Nicole (US, soft)'],
  ['af_aoede', 'Aoede (US)'], ['af_kore', 'Kore (US)'], ['af_sarah', 'Sarah (US)'],
  ['am_fenrir', 'Fenrir (US)'], ['am_michael', 'Michael (US)'], ['am_puck', 'Puck (US)'],
  ['af_sky', 'Sky (US)'], ['af_nova', 'Nova (US)'], ['af_river', 'River (US)'],
  ['af_alloy', 'Alloy (US)'], ['af_jessica', 'Jessica (US)'],
  ['am_adam', 'Adam (US)'], ['am_echo', 'Echo (US)'], ['am_eric', 'Eric (US)'],
  ['am_liam', 'Liam (US)'], ['am_onyx', 'Onyx (US)'], ['am_santa', 'Santa (US)'],
  // British
  ['bf_emma', 'Emma (UK)'], ['bf_isabella', 'Isabella (UK)'], ['bm_george', 'George (UK)'],
  ['bm_fable', 'Fable (UK)'], ['bf_alice', 'Alice (UK)'], ['bf_lily', 'Lily (UK)'],
  ['bm_lewis', 'Lewis (UK)'], ['bm_daniel', 'Daniel (UK)']
].map(([id, label]) => ({ id, label }));

// `handoff`: start in the system voice and change to the natural one when it is ready, instead
// of waiting for it. On by default — on a slow machine it is the difference between speaking at
// once and waiting the better part of a minute.
// `background`: keep reading when you leave the page you started on. The side panel is what you
// control it from, and what keeps the service worker alive while it plays.
// theme/font/size/measure: how the reader looks. 'auto' follows the browser.
export const DEFAULT_SETTINGS = {
  natural: false, handoff: true, background: true,
  systemVoice: '', neuralVoice: 'af_heart', rate: 1,
  theme: 'auto', font: 'serif', size: 21, measure: '34em'
};
