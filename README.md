# Voxly – Free Read Aloud

A Chrome extension that does one thing: turns the page you're on into clean, readable text and reads it to you, highlighting each word as it's spoken.

- Click the toolbar icon (or **Alt+Shift+R**). If you've selected text, reading starts there.
- Click any sentence to jump to it. **Space** pauses, **←/→** move by sentence, **+/−** change speed, **Esc** closes.
- **Natural voice** switches from your computer's built-in voices to Kokoro, an open neural voice that runs entirely on your machine.

[Privacy policy](https://sjayjay005.github.io/voxly/privacy.html)

## How it's built

```
src/
  reader/            content scripts, injected only when you open the reader
    extract.js       page → { title, blocks, sentences } via Readability; sentences are the unit of everything
    view.js          the reader UI (shadow DOM): text, one moving highlight marker, control dock
    reader.js        controller: wires the view to the service worker over a single Port
  background/        service worker (ES modules)
    main.js          opens the reader, owns the one reading session, routes events
    system-engine.js chrome.tts — every sentence queued up front, so no gaps
    neural-engine.js proxy to the offscreen document; closes it when idle
    voices.js        natural voice list and default settings
  offscreen/
    player.js        buffered natural-voice player (see below)
    kokoro-worker.js bundled Kokoro + ONNX runtime (built from scripts/kokoro-worker.src.js, don't edit)
lib/Readability.js   vendored from @mozilla/readability (built)
ort/                 ONNX WebAssembly runtime (built)
```

**Natural voice playback** works like a video player. It measures how fast this computer synthesizes speech, buffers enough audio up front that playback won't overtake generation (never more than ~30s), plays sentences back-to-back on one audio timeline, keeps at most 45s generated ahead, and frees each sentence's audio once it has played. If generation ever falls behind it shows *Buffering* rather than stuttering. A minute after you stop, the offscreen document closes so the model's memory is released.

**CPU or GPU, decided by measurement.** The worker has two engines: the 8-bit model (~90 MB) on WebAssembly using every core but one, and the full-precision model (~330 MB) on WebGPU. A new machine starts on the CPU engine, which is small and works everywhere. If it can't keep up with realtime and the machine has a real GPU adapter (not a software one), the worker loads the GPU engine mid-article, measures it on a couple of sentences, keeps whichever is faster and frees the other. The verdict is stored in `chrome.storage.local` (`neuralEngine`), so the next session starts on the right engine immediately; it's re-measured if the GPU adapter changes or an engine fails to load. Machines whose CPU is already faster than realtime never download the GPU model. Buffering estimates use the worker's own timing, which excludes model loading, so a fast machine starts playing after the first sentence rather than waiting out a 30s prebuffer.

**Other performance choices for modest machines:** one message per sentence instead of per word (the reader animates the highlight itself with `requestAnimationFrame`, which pauses in background tabs); no blur or always-running animations; `content-visibility` on paragraphs so long articles stay cheap.

## Development

```
npm install
npm run build   # regenerate lib/, ort/ and src/offscreen/kokoro-worker.js from package.json versions
npm run check   # syntax + manifest checks (also run in CI)
npm run zip     # build + dist/voxly-<version>.zip for the Chrome Web Store
```
Load the folder unpacked at `chrome://extensions` (Developer mode). The natural voice's console lives under **Inspect views → offscreen.html**; it logs load time, which engine (cpu/gpu) produced each sentence and its realtime factor, and `voxlyDebug()` shows buffer state and the active engine. To force a fresh CPU-vs-GPU measurement, remove the stored verdict from that console: `chrome.storage.local.remove('neuralEngine')`.

## Dependency security
Dependabot security updates are enabled; `.github/dependabot.yml` adds weekly grouped version updates and CI builds every PR. After merging one, run `npm install && npm run build` and commit the regenerated files. Alerts for `sharp` don't affect the extension (Node-only, never bundled) and are ignored.

Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0).
