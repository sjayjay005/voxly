# Vendored files

Nothing here is written by hand. Every file is copied or bundled from an npm package by
`npm run build`, from the exact versions pinned in `package-lock.json`, and committed so that
what ships is what is in git — the extension loads no code at runtime that is not in this
repository.

Every file here is readable source. Where a publisher ships both a minified and an unminified
build we vendor the unminified one, and `npm run build` fails if any script in the package reads
as minified (`scripts/package-audit.mjs`). The one exception is `../ort/ort-wasm-*.mjs`, the
Emscripten loader glue for the WASM runtime, which upstream publishes in no other form.

No control-flow flattening, string encoding, packing or `eval` is involved anywhere, and
`scripts/build.mjs` fails the build if any vendored file so much as references a CDN.

| File | From | Version | Licence |
| --- | --- | --- | --- |
| `Readability.js` | [@mozilla/readability](https://github.com/mozilla/readability) | 0.6.0 | Apache-2.0 (`Readability-LICENSE.md`) |
| `pdf.mjs`, `pdf.worker.mjs` | [pdfjs-dist](https://github.com/mozilla/pdf.js) — modern `build/`, unminified, **not** `legacy/` | 6.5.438 | Apache-2.0 (`pdfjs-LICENSE`) |
| `fflate.js` | [fflate](https://github.com/101arrowz/fflate) — `esm/browser.js` | 0.8.3 | MIT (`fflate-LICENSE`) |
| `../ort/*` | ONNX Runtime Web, as shipped inside [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 3.8.1 | MIT |
| `../src/offscreen/kokoro-worker.js` | esbuild bundle of [kokoro-js](https://github.com/hexgrad/kokoro) 1.2.1 + transformers.js 3.8.1, built from `scripts/kokoro-worker.src.js` | — | Apache-2.0 / MIT |

## A note for review

`pdfjs-dist` also publishes a `legacy/` build that bundles core-js. Voxly does not use it and
does not ship it: core-js's `NullProtoObject` creates an `iframe` and writes a script into it
through a `javascript:` URL, which looks exactly like the concealed functionality the Code
Readability policy forbids. It exists only under `node_modules/`, which is why
`npm run zip` builds the archive from an explicit list and then refuses to produce one
containing anything else (`scripts/package-audit.mjs`).

Two rejections have cited files under `node_modules/pdfjs-dist/legacy/` — `legacy/build/pdf.mjs`
and `legacy/image_decoders/pdf.image_decoders.min.mjs`. Neither path exists in the archive
`npm run zip` produces; to confirm, `unzip -Z1 voxly-<version>.zip` lists 49 entries, all of them
under `manifest.json`, `icons/`, `lib/`, `ort/` or `src/`.

To reproduce any file here:

```
npm ci          # exact versions from package-lock.json
npm run build   # regenerates lib/, ort/ and src/offscreen/kokoro-worker.js
git diff        # should be empty
```
