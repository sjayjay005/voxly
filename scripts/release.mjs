// Cut a release: verify, tag, package, and publish it to GitHub.
//
// A git tag is not a release. Tags were pushed for 2.1.0, 2.2.0 and 3.0.0 and no GitHub release
// existed for any of them, because creating one needs the API and the tag push does not — a gap
// that is invisible from the tags page. This does both, or tells you exactly what is left.
//
//   npm run release                  # notes from RELEASE_NOTES.md if present
//   npm run release -- --notes x.md  # or from a file you name
//   npm run release -- --dry-run     # check and package, publish nothing
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
const quiet = (cmd, args) => { try { return run(cmd, args).trim(); } catch { return null; } };
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;
const zip = `dist/voxly-${version}.zip`;
const dryRun = flag('--dry-run');

if (pkg.version !== version) fail(`package.json says ${pkg.version}, manifest.json says ${version}`);
if (run('git', ['status', '--porcelain']).trim()) fail('working tree is not clean — commit or stash first');

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
if (branch !== 'master') warn(`releasing from ${branch}, not master`);

console.log(`Releasing ${tag} from ${branch}\n`);

// 1. It has to actually work.
run('npm', ['run', 'check'], { stdio: 'inherit' });
run('npm', ['test'], { stdio: 'inherit' });

// 2. And the package has to contain only the extension (see scripts/package-audit.mjs).
run('npm', ['run', 'zip'], { stdio: 'inherit' });

// 3. Tag, if it is not already tagged.
const tagged = quiet('git', ['rev-parse', `${tag}^{commit}`]);
const head = run('git', ['rev-parse', 'HEAD']).trim();
if (!tagged) {
  if (dryRun) console.log(`\nwould tag ${tag}`);
  else {
    run('git', ['tag', '-a', tag, '-m', `Voxly ${version}`]);
    run('git', ['push', 'origin', tag]);
    console.log(`\n✓ tagged and pushed ${tag}`);
  }
} else if (tagged !== head) {
  warn(`${tag} already exists and points at ${tagged.slice(0, 7)}, not HEAD (${head.slice(0, 7)})`);
} else {
  console.log(`\n✓ ${tag} already points here`);
}

// 4. The part that was being missed.
const notesFile = value('--notes') || (existsSync(join(root, 'RELEASE_NOTES.md')) ? 'RELEASE_NOTES.md' : null);
const hasGh = !!quiet('which', ['gh']) && quiet('gh', ['auth', 'status']) !== null;

if (dryRun) {
  console.log(`\nDry run. Would publish ${tag} with ${notesFile || 'generated notes'} and attach ${zip}.`);
} else if (hasGh) {
  const gh = ['release', 'create', tag, zip, '--title', `${tag} — Voxly ${version}`];
  gh.push(...(notesFile ? ['--notes-file', notesFile] : ['--generate-notes']));
  run('gh', gh, { stdio: 'inherit' });
  console.log(`\n✓ published https://github.com/${repo()}/releases/tag/${tag}`);
} else {
  console.log(`
✓ ${tag} is tagged and ${zip} is built — but NOT released.

  Publishing a release needs the GitHub API, which this machine has no credentials for. Either:

    brew install gh && gh auth login && npm run release

  ...which will do it, or do it by hand once:

    https://github.com/${repo()}/releases/new?tag=${tag}

  attaching ${zip}${notesFile ? ` and pasting ${notesFile}` : ''}.`);
}

function repo() {
  const url = quiet('git', ['remote', 'get-url', 'origin']) || '';
  return (url.match(/github\.com[:/](.+?)(?:\.git)?$/) || [, 'sjayjay005/voxly'])[1];
}
function warn(msg) { console.log(`!  ${msg}`); }
function fail(msg) { console.error(`refusing to release: ${msg}`); process.exit(1); }
