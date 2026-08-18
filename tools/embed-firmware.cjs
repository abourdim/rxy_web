#!/usr/bin/env node
/*
 * Embeds firmware/main.ts into index.html.
 *
 * Why embed at all: index.html is normally opened straight from disk, and
 * Chrome blocks fetch() on file:// origins. Reading the firmware at runtime
 * would therefore fail in the one situation the dialog exists for -- someone
 * with the robot in front of them and no web server.
 *
 * The cost is a second copy of the source (~108 KB), so run this after every
 * firmware edit. It is idempotent, and `--check` exits non-zero when the two
 * have drifted, which is the useful thing to wire into a pre-commit hook.
 *
 *   node tools/embed-firmware.cjs          rewrite index.html
 *   node tools/embed-firmware.cjs --check  report drift, change nothing
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const fwPath = path.join(root, 'firmware', 'main.ts');
const htmlPath = path.join(root, 'index.html');
const check = process.argv.includes('--check');

const firmware = fs.readFileSync(fwPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');

// A literal </script> inside the payload would end the block early.
const payload = firmware.replace(/<\/script>/gi, '<\\/script>');

const built = new Date(fs.statSync(fwPath).mtime)
  .toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const block = `<script id="fwSource" type="text/plain" data-built="${built}">\n${payload}</script>`;
const re = /<script id="fwSource"[^>]*>[\s\S]*?<\/script>/;

if (!re.test(html)) {
  console.error('index.html has no <script id="fwSource"> block to fill.');
  process.exit(2);
}

const updated = html.replace(re, block);

if (check) {
  // Compare the PAYLOAD only, with newlines normalised.
  //
  // Two things would otherwise produce false drift on a perfectly correct
  // file. First, these files live on Windows and other tools rewrite them as
  // CRLF while the block above is written with plain LF. Second, and worse:
  // data-built comes from the source file's mtime, and git does not preserve
  // mtimes -- a fresh clone, or a CI checkout, stamps "now". Comparing the
  // whole block would then fail on every run for a reason nobody can act on.
  const norm = t => t.split('\r\n').join('\n');
  const current = html.match(re)[0]
    .replace(/^<script[^>]*>\r?\n?/, '')
    .replace(/<\/script>$/, '');
  const drifted = norm(current) !== norm(payload);
  console.log(drifted
    ? 'DRIFT: index.html does not match firmware/main.ts. Run: node tools/embed-firmware.cjs'
    : 'ok: embedded firmware matches the source file');
  process.exit(drifted ? 1 : 0);
}

fs.writeFileSync(htmlPath, updated);
const ver = (firmware.match(/FIRMWARE_VERSION\s*=\s*"([^"]+)"/) || [])[1] || '?';
console.log(`embedded ${firmware.length} chars (${ver}), built ${built}`);
