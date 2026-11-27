// Lists the pinned software that has a newer version out: Node.js, Python and its packages and the WebView2
// libraries. The pins are read from the files that hold them, so there is nothing to keep in step here.
// It changes nothing: a newer version is taken by editing the pin (and its checksum) and testing the result.
//   npm run check-pins      (exit code 1 when something is behind or could not be checked; pins.yml runs it monthly)
// The requests go to nodejs.org, python.org, pypi.org and api.nuget.org, and carry nothing but the package's name.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const pin = (file, re) => {
  const m = re.exec(read(file));
  if (!m) throw new Error(`no pin found in ${file}`);
  return m[1];
};
const json = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
};
const text = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.text();
};
/** Compares versions number by number: negative when a is older than b. */
const compare = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const newest = (versions) => versions.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(compare).at(-1);
const line = (version, parts) => version.split('.').slice(0, parts).join('.');
const sameLine = (versions, pinned, parts) => versions.filter((v) => line(v, parts) === line(pinned, parts));

const python = read('tools/fetch-python.mjs');
const packages = [...python.matchAll(/'([A-Za-z0-9_.-]+)==([\d.]+)'/g)].map((m) => [m[1], m[2]]);
// [what, where its pin is, the pinned version, how the latest one is found]
const pins = [
  // Node.js and Python stay on their release line: a new line is a decision, not an update
  ['Node.js', '.github/workflows/release.yml', pin('.github/workflows/release.yml', /node-version: '([\d.]+)'/),
    async (v) => newest(sameLine((await json('https://nodejs.org/dist/index.json')).map((r) => r.version.slice(1)), v, 1))],
  ['Python', 'tools/fetch-python.mjs', pin('tools/fetch-python.mjs', /const VERSION = '([\d.]+)'/),
    async (v) => newest(sameLine([...(await text('https://www.python.org/ftp/python/')).matchAll(/href="(\d+\.\d+\.\d+)\/"/g)]
      .map((m) => m[1]), v, 2))],
  ...packages.map(([name, version]) => [name, 'tools/fetch-python.mjs', version,
    async () => (await json(`https://pypi.org/pypi/${name}/json`)).info.version]),
  ['WebView2 libraries', 'tools/fetch-webview2.ps1', pin('tools/fetch-webview2.ps1', /\$version = '([\d.]+)'/),
    async () => newest((await json('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json')).versions)],
];

let behind = 0, unknown = 0;
for (const [what, file, pinned, latestOf] of pins) {
  try {
    const latest = await latestOf(pinned);
    if (!latest) throw new Error('no version found');
    const older = compare(pinned, latest) < 0;
    if (older) behind++;
    console.log(`${older ? 'behind ' : 'current'}  ${what} ${pinned}${older ? ` -> ${latest}   (${file})` : ''}`);
  } catch (e) {
    unknown++;
    console.log(`unknown  ${what} ${pinned}: ${e.message}`);
  }
}
const checked = pins.length - unknown;
console.log(behind ? `\n${behind} of ${pins.length} are behind.` : !unknown ? `\nAll ${checked} are current.`
  : checked ? `\nAll ${checked} that could be checked are current.` : '');
if (unknown) console.log(`${unknown} could not be checked.`);
process.exit(behind || unknown ? 1 : 0); // (a check that could not look is not a pass)
