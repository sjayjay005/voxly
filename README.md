# Voxly – Free Read Aloud

A Chrome extension that does one thing: turns the page you're on into clean, readable text and reads it to you, highlighting each word as it's spoken.

- Click the toolbar icon (or **Alt+Shift+R**). If you've selected text, reading starts there.
- Click any sentence to jump to it. **Space** pauses, **←/→** move by sentence, **+/−** change speed (up to 3×), **Esc** closes.
- **Listen later.** Right-click any page and choose *Listen to this later*; it waits in the player until you want it, and plays without the tab it came from.
- **Hear a voice before choosing it** with the play button beside the voice list.
- **Star a voice** and every article starts with it, whichever voice you tried last. Starring a Kokoro voice turns the natural voice on with it; starring one of your computer's voices turns it off.
- **Aa** in the dock sets the colours (auto, light, sepia, dark), the typeface (serif, sans, or a dyslexia-friendly face), the text size and the column width.
- **PDFs and EPUBs too.** Right-click the Voxly icon and choose *Read a PDF or EPUB with Voxly* to open a file. It gets the same reader, the same voices and the same highlighting as a web page.
- **It keeps reading while you browse.** Right-click the Voxly icon and choose *Open the Voxly player* for a side panel that outlives the page you started on — switch tabs or close that tab and the voice carries on, with the transport, speed and natural-voice switch in the panel.
- **The reading tab is marked.** While Voxly reads, that tab shows ▶ in front of its title and takes Voxly's icon, so you can find it from anywhere in the tab strip. Both go back to normal when you close the reader.
- **Natural voice** switches from your computer's built-in voices to Kokoro, an open neural voice that runs entirely on your machine. It starts speaking immediately in your system voice and changes over once Kokoro is ready, so a slow computer never leaves you waiting.

[Privacy policy](https://sjayjay005.github.io/voxly/privacy.html)

## How it's built

```
src/
  doc/               the document model and the reading session, shared by every source
    model.js         text → { title, blocks, sentences, blockStarts }; sentences are the unit of everything
    session.js       one reading session: the view, one Port, reconnection, the word clock
    tab-mark.js      marks the reading tab in the tab strip, and puts it back afterwards
  panel/             the side panel: the player and the listen-later queue
  welcome/           what opens once, on install
  reader/            content scripts, injected only when you open the reader on a page
    extract.js       the page → blocks, via Readability
    view.js          the reader UI (shadow DOM): text, one moving highlight marker, control dock
    reader.js        toggles the reader on the current page
  viewer/            the file reader, an extension page
    viewer.html/js   drop a PDF or EPUB; text only, no page is ever rendered
    pdf-layout.js    positioned text runs → paragraphs, inferred from the geometry
    epub.js          container → package file → spine; chapters reuse blocksFrom()
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
test/                node --test over the pacing, model and PDF-layout logic
lib/Readability.js   vendored from @mozilla/readability (built)
lib/pdf*.mjs         vendored from pdfjs-dist (built)
lib/fflate.js        vendored from fflate, to unzip EPUBs (built)
ort/                 ONNX WebAssembly runtime (built)
```

**Natural voice playback** works like a video player with a download manager. A generator synthesizes the whole article in order and saves each sentence to a local audio cache (IndexedDB, 16-bit PCM, ~200 MB cap, least-recently-played evicted), so replays and resumes start instantly. The player measures how fast this computer synthesizes speech (and remembers it), buffers enough audio up front that playback won't overtake generation — never asking you to wait more than ~45s — plays sentences back-to-back on one audio timeline, keeps only ~30s decoded in memory, and frees each sentence's audio once it has played. On a machine too slow to keep up, it offers to switch to the standard voice. If generation ever falls behind it shows *Buffering* rather than stuttering. A minute after you stop, the offscreen document closes so the model's memory is released.

**Reading on after you leave the page.** The reading session used to belong to whichever Port had connected, so closing the tab tore it down. It now belongs to the *document*, and any number of clients may watch it — the reader overlay in a page, and the side panel. A client going away only ends the session if nothing else is listening and the person has not asked Voxly to carry on (`background`, on by default).

Two details make it actually work. Chrome stops an idle service worker after about 30 seconds, so the panel heartbeats like the reader does — but only while something is playing, since an open panel with nothing to read has no business holding the worker resident. And the panel keeps no copy of the document: the worker sends it the title, the position and the sentence being spoken, which is also why a panel opened halfway through an article can render the right state immediately.

This is a side panel rather than a popup on purpose. A popup would have meant `action.default_popup`, which is mutually exclusive with `action.onClicked` — so clicking the toolbar icon would have opened a menu instead of reading the page, and one-click-to-read is the whole interaction. The side panel costs one extra permission (`sidePanel`) and no host permissions.

**The queue stores text, not links.** Fetching a queued page later would need permission to read every site you visit, which Voxly does not ask for — so the article is extracted at the moment you add it, while the click that asked for it still grants `activeTab`. An entry is therefore a snapshot; re-add a page to pick up changes. It lives in `chrome.storage.local` (sync storage allows 100 KB, and one article can exceed that), capped at 50 entries and about 400,000 characters, dropping whatever has waited longest. The panel is sent a summary without the sentences, because redrawing a list should not move megabytes.

**Voice preview** sits above the session check in the offscreen player and touches no session state, so it cannot disturb a reading or start one. It is disabled while something plays: the worker runs one inference at a time, so a preview would queue behind the current sentence and arrive after you had stopped caring.

**A favourite voice** exists because the chosen voice always persisted, which meant the last voice you tried silently became your default — so auditioning one cost you your preference. The star records a voice *and* its engine, and `favouritePatch()` is applied once per document rather than on every `play()`, so changing voice mid-article still works and still lasts the session. It just no longer decides what the next article starts with. With nothing starred, the old last-used behaviour is unchanged.

**Appearance** is four CSS custom properties — `--size`, `--measure`, `--face` and the colour tokens — set on the reader's root, so changing any of them re-renders nothing. The one subtlety is that "auto" has to keep following the browser while an explicit choice overrides it, so the dark tokens live behind `:not([data-theme="light"]):not([data-theme="sepia"])` and are declared again under `[data-theme="dark"]`. The dyslexia-friendly option asks for OpenDyslexic, then Atkinson Hyperlegible, then Verdana: no font file is shipped, so it uses whichever of the first two you have installed and falls back to a face that is everywhere and still more legible than a default sans.

**Accessibility.** The reader is a modal layer over a page that is still there and still focusable, so Tab is trapped inside it. Screen-reader announcements go to a separate visually-hidden live region rather than the visible status line, which changes on every sentence and would be unbearable to listen to — only playing, paused, finished, buffering, stopped and errors are announced.

**Finding the tab that's reading.** Chrome's own speaker icon never appears for Voxly, because the audio comes from the offscreen document or from `chrome.tts` rather than from the tab — so a tab that is reading looks identical to one that isn't. The tab strip only exposes two things a page can set, its title and its favicon, so Voxly borrows both while reading and restores them on close. The title is the dependable one; a favicon from a `data:` URI can be refused by a strict page CSP, so it is best-effort. If the page rewrites its own title while reading (a single-page app navigating), the new title is adopted and re-marked rather than being forced back. The toolbar icon gets a badge too, which is what you see once you return to the tab.

**Reading a PDF.** A PDF has no paragraphs — only glyphs at coordinates — so `pdf-layout.js` infers the structure from geometry: it groups text runs into lines, then starts a new paragraph on a wide vertical gap, an indent, or a short line that ends in a full stop. Lines that repeat in the same place on most pages are running heads and get dropped, as do page numbers; end-of-line hyphenation is undone when lines are joined. A line noticeably taller than the body text becomes a heading. From there it is the same model a web page produces, so the reader, the voices and the word highlighting are unchanged.

Reading starts after the first six pages, not after the whole file. A long book would otherwise sit in silence while every page was extracted; the rest is extracted ten pages at a time behind the playhead and appended as it arrives, which is why `model.js`, the view and both engines can all grow a document mid-sentence. One cost of extracting in batches: a paragraph that straddles a batch boundary reads as two, and running heads are detected per batch rather than across the whole file.

Three limits worth knowing: a scanned PDF has no text to extract (there is no OCR), and CJK text needs character maps that aren't vendored. Chrome also blocks extensions from running on its own PDF viewer, and reaching a PDF's bytes would need host permissions on every site — so Voxly asks you to open your copy of the file instead.

**Reading an EPUB** is far less work than a PDF, because an EPUB writes its reading order down: `META-INF/container.xml` points at the package file, which lists a manifest and a spine, and each spine document is XHTML — so once unzipped, the same `blocksFrom()` that handles a web page handles a chapter. Only the textual entries are decompressed; an EPUB is mostly images and none of them are needed. Chapters are parsed in batches so a long book starts reading before all of it has been through the parser, and `linear="no"` spine entries are skipped as front or back matter. The fiddly part is path resolution — manifest hrefs are relative to the package file's directory, URL-encoded and sometimes carry a fragment, while the lookup they feed is a flat list of zip entry names — so that part is pure and covered by tests.

**On a machine slower than realtime** the natural voice used to make you wait up to 45 seconds, then offer to turn itself off. Four things replace that:

- **It speaks straight away.** Your system voice reads from the first word while Kokoro generates in the background, muted — aimed at a point *further down* the article, because generating from where the system voice already is could never catch up with it. Once the buffer there is full, playback changes over at the next paragraph break. On a machine at half realtime that is about nine sentences in; on a very slow one, further. A computer that could fill its buffer within a few seconds declines the lead-in before the system voice is audible, so you hear one voice, not two. Turn it off with *Always wait for it instead* on the hint that appears after the first changeover.
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
**Submitting to the Chrome Web Store: always use `npm run zip`.** Zipping the project folder
sweeps in `node_modules`, and `pdfjs-dist` publishes a `legacy/` build in there that bundles
core-js — whose `NullProtoObject` writes a script into an iframe via a `javascript:` URL. Voxly
neither uses nor ships that code, but a reviewer who finds it in the package reads it as
concealed functionality, and 3.0.0 was rejected for exactly that. `npm run zip` builds the
archive from an explicit list of five paths and then refuses to emit one containing anything
else; `lib/VENDOR.md` records where every vendored file came from.

Load the folder unpacked at `chrome://extensions` (Developer mode). The natural voice's console lives under **Inspect views → offscreen.html**; it logs load time and realtime factor per sentence, and `voxlyDebug()` shows buffer state, which engine is playing, the thread measurements so far and how many sentences are currently bridged from another speed.

To test the slow path on a fast machine, throttle the CPU 4–6× in DevTools (Performance → CPU) before opening the reader.

## Dependency security
Dependabot security updates are enabled; `.github/dependabot.yml` adds weekly grouped version updates and CI builds every PR. After merging one, run `npm install && npm run build` and commit the regenerated files. Alerts for `sharp` don't affect the extension (Node-only, never bundled) and are ignored.

Voxly is MIT licensed — see [LICENSE](LICENSE). Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0), vendored under `lib/`.
