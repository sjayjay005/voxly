# Voxly – Free Read Aloud

A free Chrome extension that reads selected text or whole articles aloud, with word highlighting, speed control and your choice of voice.

- Right-click text → **Read selection aloud**, or **Read this page aloud**
- Floating player: pause, skip sentence, speed −/+
- Shortcuts: `Alt+Shift+R` read, `Alt+Shift+P` pause
- No account, no tracking

## Install for development
1. Clone this repo
2. Go to `chrome://extensions`, enable **Developer mode**
3. Click **Load unpacked** and select this folder

## Privacy
See [privacy.html](https://sjayjay005.github.io/voxly/privacy.html).

## Credits
Article extraction uses [Mozilla Readability](https://github.com/mozilla/readability) (Apache-2.0, see `Readability-LICENSE.md`).

## Neural voices (v1.1)
`kokoro-worker.js` is a bundle of [kokoro-js](https://github.com/hexgrad/kokoro) + transformers.js. To rebuild it:
```
npm i kokoro-js esbuild
npx esbuild build/kokoro-worker.src.js --bundle --format=iife --platform=browser --minify --target=chrome116 \
  --alias:fs/promises=./build/empty.js --alias:path=./build/empty.js --alias:fs=./build/empty.js \
  --external:onnxruntime-node --outfile=kokoro-worker.js
```
then replace the jsDelivr wasm fallback URL in the bundle with `${self.location.origin}/ort/`, and copy the `ort-wasm-simd-threaded*` files from `@huggingface/transformers/dist` and `onnxruntime-web/dist` into `ort/`.
