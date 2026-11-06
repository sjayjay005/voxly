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
    kokoro-worker.js bundled Kokoro + ONNX runtime (built, don't edit)
lib/Readability.js   vendored from @mozilla/readability (built)
ort/                 ONNX WebAssembly runtime (built)
```

**Natural voice playback** works like a video player with a download manager. A generator synthesizes the whole article in order and saves each sentence to a local audio cache (IndexedDB, 16-bit PCM, ~200 MB cap, least-recently-played evicted), so replays and resumes start instantly. The player measures how fast this computer synthesizes speech (and remembers it), buffers enough audio up front that playback won't overtake generation — never asking you to wait more than ~45s — plays sentences back-to-back on one audio timeline, keeps only ~30s decoded in memory, and frees each sentence's audio once it has played. On a machine too slow to keep up, it offers to switch to the standard voice. If generation ever falls behind it shows *Buffering* rather than stuttering. A minute after you stop, the offscreen document closes so the model's memory is released.

**Performance choices for modest machines:** 8-bit CPU model (~90 MB) instead of the GPU model (~330 MB); half the CPU cores; one message per sentence instead of per word (the reader animates the highlight itself with `requestAnimationFrame`, which pauses in background tabs); no blur or always-running animations; `content-visibility` on paragraphs so long articles stay cheap.

**Resilience:** Chrome stops an idle extension service worker after ~30s, and a slow machine can take longer than that to generate one sentence. The reader sends a heartbeat every 20s, and if the connection still drops it reconnects and resumes from the current sentence.

**Tip for older Macs:** Apple's Premium and Enhanced voices (System Settings → Accessibility → Spoken Content → System voice → Manage Voices) sound close to neural voices and cost almost no CPU. Voxly lists them first when Natural voice is off.

## Development

```
npm install
npm run build   # regenerate lib/, ort/ and src/offscreen/kokoro-worker.js from package.json versions
npm run check   # syntax + manifest checks (also run in CI)
npm run zip     # build + dist/voxly-<version>.zip for the Chrome Web Store
```
Load the folder unpacked at `chrome://extensions` (Developer mode). The natural voice's console lives under **Inspect views → offscreen.html**; it logs load time and realtime factor per sentence, and `voxlyDebug()` shows buffer state.

## Dependency security
Dependabot security updates are enabled; `.github/dependabot.yml` adds weekly grouped version updates and CI builds every PR. After merging one, run `npm install && npm run build` and commit the regenerated files. Alerts for `sharp` don't affect the extension (Node-only, never bundled) and are ignored.

Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0).
