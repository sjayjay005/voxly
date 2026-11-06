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

## Building
The extension ships with a few vendored files built from npm packages (`Readability.js`, `kokoro-worker.js`, `ort/`).
```
npm install
npm run build     # regenerate the vendored files from package.json versions
npm run zip       # same, plus dist/voxly-<version>.zip for the Chrome Web Store
```

## Dependency security
- **Dependabot security updates** are enabled in Settings → Advanced Security, and `.github/dependabot.yml` adds weekly grouped version updates.
- The **Build** workflow runs on every PR, so a Dependabot bump that breaks the bundle fails before you merge.
- After merging a Dependabot PR, run `npm install && npm run build` (or `npm run zip`) and commit the regenerated files — the extension uses the vendored copies, not `node_modules`.
- Alerts for `sharp` (pulled in by `@huggingface/transformers`) don't affect the extension: sharp is a Node-only image library and isn't included in the browser bundle. They can be dismissed as "vulnerable code is not actually used".
