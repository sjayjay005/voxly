# Voxly – Free Read Aloud

A Chrome extension that does one thing: turns the page you're on into clean, readable text and reads it to you, highlighting each word as it's spoken.

- Click the toolbar icon (or **Alt+Shift+R**). If you've selected text, reading starts there.
- Click any sentence to jump to it. **Space** pauses, **←/→** move by sentence, **+/−** change speed, **Esc** closes.
- **Natural voice** switches from your computer's built-in voices to Kokoro, an open neural voice that runs entirely on your machine. It starts speaking immediately in your system voice and changes over once Kokoro is ready, so a slow computer never leaves you waiting.

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
    hybrid-engine.js starts in the system voice, hands over to the natural one
    voices.js        natural voice list and default settings
  offscreen/
    player.js        buffered natural-voice player (see below)
    pacing.js        the buffering arithmetic, on its own so it can be tested
    audio-cache.js   generated audio in IndexedDB, 16-bit PCM, oldest evicted
    kokoro-worker.js bundled Kokoro + ONNX runtime (built, don't edit)
test/                node --test over pacing.js
lib/Readability.js   vendored from @mozilla/readability (built)
ort/                 ONNX WebAssembly runtime (built)
```

**Natural voice playback** works like a video player with a download manager. A generator synthesizes the whole article in order and saves each sentence to a local audio cache (IndexedDB, 16-bit PCM, ~200 MB cap, least-recently-played evicted), so replays and resumes start instantly. The player measures how fast this computer synthesizes speech (and remembers it), buffers enough audio up front that playback won't overtake generation — never asking you to wait more than ~45s — plays sentences back-to-back on one audio timeline, keeps only ~30s decoded in memory, and frees each sentence's audio once it has played. On a machine too slow to keep up, it offers to switch to the standard voice. If generation ever falls behind it shows *Buffering* rather than stuttering. A minute after you stop, the offscreen document closes so the model's memory is released.

**On a machine slower than realtime** the natural voice used to make you wait up to 45 seconds, then offer to turn itself off. Four things replace that:

- **It speaks straight away.** Your system voice reads from the first word while Kokoro generates in the background, muted. When there is enough audio to keep going, playback changes over at the next paragraph break. A computer fast enough not to need this declines the lead-in before the system voice is audible, so you hear one voice, not two. Turn it off with *Always wait for it instead* on the hint that appears after the first changeover.
- **Changing speed costs nothing.** Audio already generated keeps playing — resampled, so its pitch shifts slightly — while the generator re-makes it at the new speed and swaps each sentence in as it arrives. Moving the speed control used to discard every second of audio already made, because the speed is part of the cache key.
- **The opening sentences are generated clause by clause.** One 240-character sentence is a single inference; at half realtime that sentence alone is a ~30-second wait. The first three are cut at clause boundaries, concatenated, and cached as one sentence, so the first sound arrives several times sooner.
- **It learns this computer.** The thread count is measured rather than guessed: one candidate per session, the realtime factor remembered, and the best one kept (`voxly.threads` in the offscreen document's local storage). A model that took 20 seconds to load is also kept in memory for longer than one that loaded instantly, instead of a flat minute.

**Other performance choices for modest machines:** the 8-bit CPU model (~90 MB) — also the smallest kokoro-js offers, since q4 is *larger* at 305 MB; one message per sentence instead of per word (the reader animates the highlight itself with `requestAnimationFrame`, which pauses in background tabs); no blur or always-running animations; `content-visibility` on paragraphs so long articles stay cheap.

**Resilience:** Chrome stops an idle extension service worker after ~30s, and a slow machine can take longer than that to generate one sentence. The reader sends a heartbeat every 20s, and if the connection still drops it reconnects and resumes from the current sentence.

**Tip for older Macs:** Apple's Premium and Enhanced voices (System Settings → Accessibility → Spoken Content → System voice → Manage Voices) sound close to neural voices and cost almost no CPU. Voxly lists them first when Natural voice is off.

## Development

```
npm install
npm run build   # regenerate lib/, ort/ and src/offscreen/kokoro-worker.js from package.json versions
npm run check   # syntax + manifest checks (also run in CI)
npm test        # node --test over the pacing arithmetic (also run in CI)
npm run zip     # build + dist/voxly-<version>.zip for the Chrome Web Store
```
Load the folder unpacked at `chrome://extensions` (Developer mode). The natural voice's console lives under **Inspect views → offscreen.html**; it logs load time and realtime factor per sentence, and `voxlyDebug()` shows buffer state, which engine is playing, the thread measurements so far and how many sentences are currently bridged from another speed.

To test the slow path on a fast machine, throttle the CPU 4–6× in DevTools (Performance → CPU) before opening the reader.

## Dependency security
Dependabot security updates are enabled; `.github/dependabot.yml` adds weekly grouped version updates and CI builds every PR. After merging one, run `npm install && npm run build` and commit the regenerated files. Alerts for `sharp` don't affect the extension (Node-only, never bundled) and are ignored.

Voxly is MIT licensed — see [LICENSE](LICENSE). Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0), vendored under `lib/`.
