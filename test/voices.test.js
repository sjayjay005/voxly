// The voice list and the default settings. Small checks, but each one covers a way the reader
// can end up in a state the UI cannot represent — a default voice that is not in the dropdown,
// or a default text size with no button to match it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEURAL_VOICES, DEFAULT_SETTINGS, favouritePatch } from '../src/background/voices.js';

// Mirrors the choices offered by the "Aa" sheet in src/reader/view.js.
const OFFERED = { theme: ['auto', 'light', 'sepia', 'dark'], font: ['serif', 'sans', 'dyslexic'], size: [17, 19, 21, 24, 28], measure: ['28em', '34em', '42em'] };

test('every Kokoro voice kokoro-js ships is listed, once', () => {
  assert.equal(NEURAL_VOICES.length, 28, 'kokoro-js publishes 20 US and 8 UK voices');
  assert.equal(new Set(NEURAL_VOICES.map((v) => v.id)).size, 28, 'no duplicates');
});

test('every voice has an id in the documented shape and a human label', () => {
  for (const v of NEURAL_VOICES) {
    assert.match(v.id, /^[ab][fm]_[a-z]+$/, `${v.id} is not <accent><gender>_<name>`);
    assert.ok(v.label && v.label !== v.id, `${v.id} needs a label`);
    assert.match(v.label, /\((US|UK)[^)]*\)$/, `${v.label} should say which accent it is`);
  }
});

test('the default voice is one the dropdown offers', () => {
  // Otherwise the select falls back silently and the stored setting never matches what plays.
  assert.ok(NEURAL_VOICES.some((v) => v.id === DEFAULT_SETTINGS.neuralVoice));
});

test('defaults cover every setting the reader and panel read', () => {
  for (const key of ['natural', 'handoff', 'background', 'systemVoice', 'neuralVoice', 'rate', 'favourite', 'favouriteNatural', 'theme', 'font', 'size', 'measure']) {
    assert.ok(key in DEFAULT_SETTINGS, `missing default for ${key}`);
  }
});

test('each appearance default matches a button in the sheet', () => {
  // A default with no matching button would show the sheet with nothing selected.
  for (const [key, allowed] of Object.entries(OFFERED)) {
    assert.ok(allowed.includes(DEFAULT_SETTINGS[key]), `${key} default ${DEFAULT_SETTINGS[key]} is not offered`);
  }
});

test('the defaults are the conservative ones', () => {
  // Nothing downloads a model or changes the page's look until asked.
  assert.equal(DEFAULT_SETTINGS.natural, false, 'the 90 MB model must be opt-in');
  assert.equal(DEFAULT_SETTINGS.rate, 1);
  assert.equal(DEFAULT_SETTINGS.theme, 'auto', 'follow the browser until told otherwise');
});

// ---------------------------------------------------------------- favourite voice

const base = { ...DEFAULT_SETTINGS };

test('no favourite means nothing to change, so the last voice carries over as before', () => {
  assert.equal(favouritePatch(base), null);
  assert.equal(favouritePatch({ ...base, favourite: '' }), null);
  assert.equal(favouritePatch(undefined), null);
});

test('a starred Kokoro voice turns the natural voice on with it', () => {
  // Starring a voice is starring an engine too: there is no point starting on a Kokoro voice
  // with the natural voice switched off.
  assert.deepEqual(favouritePatch({ ...base, favourite: 'bf_emma', favouriteNatural: true }),
    { natural: true, neuralVoice: 'bf_emma' });
});

test('a starred system voice turns the natural voice off', () => {
  assert.deepEqual(favouritePatch({ ...base, natural: true, favourite: 'Daniel', favouriteNatural: false }),
    { natural: false, systemVoice: 'Daniel' });
});

test('a favourite already in use needs no change', () => {
  // Otherwise every play() would write settings and broadcast for nothing.
  assert.equal(favouritePatch({ ...base, natural: true, neuralVoice: 'bf_emma', favourite: 'bf_emma', favouriteNatural: true }), null);
  assert.equal(favouritePatch({ ...base, natural: false, systemVoice: 'Daniel', favourite: 'Daniel', favouriteNatural: false }), null);
});

test('a favourite overrides whatever was tried last', () => {
  // The whole point: experimenting with am_onyx must not cost you your starred voice.
  const tried = { ...base, natural: true, neuralVoice: 'am_onyx', favourite: 'af_heart', favouriteNatural: true };
  assert.deepEqual(favouritePatch(tried), { natural: true, neuralVoice: 'af_heart' });
});

test('the same voice id starred under each engine is kept distinct', () => {
  // A system voice could in principle be named like a Kokoro id; the engine decides the field.
  assert.deepEqual(favouritePatch({ ...base, natural: false, favourite: 'af_heart', favouriteNatural: true }),
    { natural: true, neuralVoice: 'af_heart' });
  assert.deepEqual(favouritePatch({ ...base, natural: true, favourite: 'af_heart', favouriteNatural: false }),
    { natural: false, systemVoice: 'af_heart' });
});

test('a starred voice that no longer exists still produces a patch', () => {
  // A system voice can be uninstalled. Applying it lets the reader fall back visibly rather
  // than silently ignoring the preference.
  assert.deepEqual(favouritePatch({ ...base, favourite: 'A Voice That Left', favouriteNatural: false }),
    { natural: false, systemVoice: 'A Voice That Left' });
});
