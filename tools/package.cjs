// Builds dist/yt-regret-<version>.zip for the Chrome Web Store from extension/.
// Usage: npm run package
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const IGNORE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\..*\.swp)$/;

function listFiles(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(path.join(dir, entry.name), rel);
    return IGNORE.test(rel) ? [] : [rel];
  }).sort();
}

// Every file the manifest (and the options page it names) points at must be in the package.
function referencedFiles(manifest) {
  const refs = new Set(Object.values(manifest.icons ?? {}));
  for (const script of manifest.content_scripts ?? []) {
    [...(script.js ?? []), ...(script.css ?? [])].forEach((file) => refs.add(file));
  }
  const options = manifest.options_ui?.page ?? manifest.options_page;
  if (options) {
    refs.add(options);
    const html = fs.readFileSync(path.join(SRC, options), 'utf8');
    for (const [, ref] of html.matchAll(/\b(?:src|href)="([^"#:]+)"/g)) {
      refs.add(path.posix.join(path.posix.dirname(options), ref));
    }
  }
  return [...refs];
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mtime } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data);
    const { time, day } = dosDateTime(mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const files = listFiles(SRC);
const missing = referencedFiles(manifest).filter((ref) => !files.includes(ref));
if (missing.length) {
  console.error(`Missing files referenced by the extension:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const entries = files.map((name) => {
  const full = path.join(SRC, name);
  return { name, data: fs.readFileSync(full), mtime: fs.statSync(full).mtime };
});
fs.mkdirSync(DIST, { recursive: true });
const out = path.join(DIST, `yt-regret-${manifest.version}.zip`);
fs.writeFileSync(out, zip(entries));

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
console.log(`${path.relative(ROOT, out)}  (${files.length} files, ${kb(fs.statSync(out).size)})`);
for (const entry of entries) console.log(`  ${entry.name.padEnd(24)} ${kb(entry.data.length)}`);
