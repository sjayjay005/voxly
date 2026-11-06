// Kokoro voice ids are <accent><gender>_<name>: a = American, b = British; f = female, m = male.
export const NEURAL_VOICES = [
  ['af_heart', 'Heart (US)'], ['af_bella', 'Bella (US)'], ['af_nicole', 'Nicole (US, soft)'], ['af_sarah', 'Sarah (US)'],
  ['af_sky', 'Sky (US)'], ['af_nova', 'Nova (US)'], ['af_river', 'River (US)'], ['af_jessica', 'Jessica (US)'],
  ['am_michael', 'Michael (US)'], ['am_fenrir', 'Fenrir (US)'], ['am_puck', 'Puck (US)'], ['am_adam', 'Adam (US)'],
  ['am_eric', 'Eric (US)'], ['am_liam', 'Liam (US)'], ['am_onyx', 'Onyx (US)'],
  ['bf_emma', 'Emma (UK)'], ['bf_isabella', 'Isabella (UK)'], ['bf_alice', 'Alice (UK)'], ['bf_lily', 'Lily (UK)'],
  ['bm_george', 'George (UK)'], ['bm_fable', 'Fable (UK)'], ['bm_lewis', 'Lewis (UK)'], ['bm_daniel', 'Daniel (UK)']
].map(([id, label]) => ({ id, label }));

// `handoff`: start in the system voice and change to the natural one when it is ready, instead
// of waiting for it. On by default — on a slow machine it is the difference between speaking at
// once and waiting the better part of a minute.
export const DEFAULT_SETTINGS = { natural: false, handoff: true, systemVoice: '', neuralVoice: 'af_heart', rate: 1 };
